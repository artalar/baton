/**
 * Deterministic stuck-loop detector. Pure: no I/O.
 *
 * Every finished tool call is reduced to a few "keys":
 * - fail:<test name>  a test run (vitest/jest/…) whose output names a failing test;
 * - read:<path>       a re-read of a source file (read tool, or bash cat/sed/head/tail/awk/nl of a path);
 * - write:<path>      an edit/write (resets the re-read counter of that path).
 * A loop is `maxHops` hops (edit/write → test/build run → the same failure again) on one failure
 * signature, or the same file re-read `readRepeatThreshold` times without a write within `windowCalls`.
 */
import { errorSignature, normPath, TEST_CMD } from "./journal.ts";
import { matchesAny } from "./util.ts";

export interface LoopConfig {
	enabled: boolean;
	/** Sliding window, in tool calls. */
	windowCalls: number;
	/** Fire after this many hops on the same failing test/error: edit/write → run (test/build) → same failure. */
	maxHops: number;
	/** A hop chain breaks when two failures of the same signature are more than this many calls apart. */
	hopGapCalls: number;
	/** Same file re-read this many times inside the window without a write to it → loop (0 = off). */
	readRepeatThreshold: number;
	/** Cut the looping calls/results out of the context (at the handoff the loop forces; on the fly only in mask.mode "continuous") and replace them with one note. */
	cutContext: boolean;
	/** On firing, force a handoff (auto baton_help with the loop as reason) instead of only a nudge. Handoff mode only. */
	forceHandoff: boolean;
	/** Block edit/write of files tied to a deferred item until the reviewer or user unblocks it. */
	blockDeferredEdits: boolean;
	/** Reads of these paths never count (reference docs, dependencies). */
	ignoreReadPaths: string[];
}

export interface LoopObs {
	toolCallId: string;
	tool: string;
	input: Record<string, unknown>;
	output: string;
	isError?: boolean;
}

export interface LoopKeys {
	fail?: string;
	/** Test file of the failing test, when the runner printed it. */
	failFile?: string;
	reads: string[];
	writes: string[];
	errLine?: string;
	/** A test run that failed without naming the test (e.g. output filtered through grep). */
	testFailed?: boolean;
	/** Quoted strings of a test command (grep patterns, -t filters): used to attribute unnamed failures. */
	hints?: string[];
	/** The call ran tests or a build (one "run" of a hop). */
	run?: boolean;
}

export interface LoopEntry {
	n: number;
	toolCallId: string;
	keys: LoopKeys;
}

export interface LoopFire {
	kind: "test" | "read";
	/** Human target, e.g. test "lock delay locks a grounded piece" or file src/model/tetris.ts. */
	target: string;
	key: string;
	count: number;
	/** toolCallIds of the looping span (first occurrence in the window … current call). */
	span: string[];
	/** Files whose edits are soft-blocked while deferred (the failing test file). */
	files: string[];
	sig?: string;
	at: number;
	hops?: number;
}

const FAIL_LINE = /^\s*(?:×|✗|✕|✘)\s+(.+?)(?:\s+\d+(?:\.\d+)?\s?m?s)?\s*$/;
const FAIL_HEAD = /^\s*FAIL\s+(\S+\.\w+)\s+>\s+(.+?)(?:\s+\d+(?:\.\d+)?\s?m?s)?\s*$/;
const ERR_LINE = /(AssertionError|Error:|error TS\d+|expected .* to )/;

/** Pure: names of failing tests printed by common runners (vitest/jest/mocha style). */
export function failingTests(output: string): { name: string; file?: string }[] {
	const out: { name: string; file?: string }[] = [];
	for (const line of output.split("\n")) {
		const h = line.match(FAIL_HEAD);
		if (h) {
			const parts = h[2]!.split(" > ");
			out.push({ name: parts[parts.length - 1]!.trim(), file: h[1] });
			continue;
		}
		const m = line.match(FAIL_LINE);
		if (m && !/^\d+\s/.test(m[1]!)) out.push({ name: m[1]!.trim() });
	}
	return out;
}

const BUILD_CMD = /\b(tsc|vite build|npm run (build|typecheck|check)|pnpm (build|typecheck)|cargo (build|check)|go build)\b/;

const READ_CMD = /^(cat|sed|head|tail|awk|nl|less|more|bat)\b/;

/** Pure: file paths read by a simple bash command (quoted programs stripped, `cd` followed). */
export function bashReads(command: string, cwd: string): string[] {
	const stripped = command.replace(/<<-?\s*'?(\w+)'?[\s\S]*?\n\1\b/g, "").replace(/'[^']*'|"[^"]*"/g, " ");
	let dir = cwd;
	const out: string[] = [];
	for (const seg of stripped.split(/&&|;|\|\||\|/).map((s) => s.trim()).filter(Boolean)) {
		const cd = seg.match(/^cd\s+(\S+)/);
		if (cd) {
			dir = normAbs(cd[1]!, dir);
			continue;
		}
		if (!READ_CMD.test(seg)) continue;
		for (const tok of seg.split(/\s+/).slice(1)) {
			if (tok.startsWith("-") || /^[<>&\d]/.test(tok) || !/[./]/.test(tok)) continue;
			out.push(normPath(normAbs(tok, dir), cwd));
		}
	}
	return out;
}

function normAbs(p: string, dir: string): string {
	if (p.startsWith("/")) return p;
	const parts = `${dir}/${p}`.split("/");
	const st: string[] = [];
	for (const x of parts) {
		if (!x || x === ".") continue;
		if (x === "..") st.pop();
		else st.push(x);
	}
	return `/${st.join("/")}`;
}

/** Pure: reduce one tool call to loop keys. */
export function loopKeys(o: LoopObs, cwd: string, ignore: readonly string[]): LoopKeys {
	const k: LoopKeys = { reads: [], writes: [] };
	const p = typeof o.input.path === "string" ? o.input.path : typeof o.input.file_path === "string" ? o.input.file_path : undefined;
	const keep = (f: string) => !matchesAny(f, ignore);
	if (o.tool === "read" && p) k.reads = [normPath(p, cwd)].filter(keep);
	if ((o.tool === "edit" || o.tool === "write") && p) k.writes = [normPath(p, cwd)];
	if (o.tool === "bash" && typeof o.input.command === "string") {
		const cmd = o.input.command;
		if (/(^|[;&|]\s*)(cat|tee|echo|printf)\b[^|;&]*>\s*[\w./-]|\bsed\s+-i\b|\brm\s+(-\w+\s+)*[\w./-]+\.\w+|open\([^)]*['"]w['"]|write_text\(/.test(cmd)) k.writes = ["(bash)"];
		if (TEST_CMD.test(cmd) || BUILD_CMD.test(cmd)) k.run = true;
		if (TEST_CMD.test(cmd)) {
			const f = failingTests(o.output);
			if (f.length) {
				k.fail = f[0]!.name;
				k.failFile = f.find((x) => x.name === k.fail && x.file)?.file;
			} else if (/AssertionError|\bFAIL\b|\d+ failed/.test(o.output)) {
				k.testFailed = true;
				k.hints = [...cmd.matchAll(/'([^']{5,})'|"([^"]{5,})"/g)].map((m) => (m[1] ?? m[2])!);
			}
			if (f.length || k.testFailed) k.errLine = o.output.split("\n").find((l) => ERR_LINE.test(l))?.trim().slice(0, 120);
		} else if (BUILD_CMD.test(cmd)) {
			// the whole set of error codes+locations: fixing any error changes the signature (= progress)
			const ts = [...new Set(o.output.match(/[\w./-]+\(\d+,\d+\): error TS\d+/g) ?? [])].sort();
			const sig = ts.length ? ts.join(" ") : /error\b|Error:/.test(o.output) ? errorSignature(o.output, true) : null;
			if (sig) {
				k.fail = `build: ${sig}`;
				k.errLine = sig;
			}
		} else k.reads = bashReads(cmd, cwd).filter(keep);
	}
	return k;
}

export interface LoopState {
	n: number;
	entries: LoopEntry[];
	/** Keys whose items were deferred/resolved: occurrences at or before `since` are ignored. */
	quiet: Record<string, number>;
	/** Per failure signature: hop count, call of the chain start, call of the last failure, edited since then. */
	hops: Record<string, { hops: number; from: number; last: number; edited: boolean; pending: number }>;
}

export function initialLoopState(): LoopState {
	return { n: 0, entries: [], quiet: {}, hops: {} };
}

/** Pure reducer: add one observation; returns a fire when a loop is detected. */
export function observeLoop(s: LoopState, toolCallId: string, keys: LoopKeys, cfg: LoopConfig): { state: LoopState; fire?: LoopFire } {
	const n = s.n + 1;
	const entries = [...s.entries, { n, toolCallId, keys }].filter((e) => e.n > n - cfg.windowCalls);
	const state: LoopState = { ...s, n, entries };
	if (!cfg.enabled) return { state };
	const live = (key: string) => entries.filter((e) => e.n > (s.quiet[key] ?? 0));
	if (!keys.fail && keys.testFailed && keys.hints?.length) {
		// attribute an unnamed failure to a recently failing test the command greps for
		const name = [...entries].reverse().find((e) => e.keys.fail && keys.hints!.some((h) => e.keys.fail!.includes(h)))?.keys.fail;
		if (name) {
			keys = { ...keys, fail: name };
			entries[entries.length - 1] = { n, toolCallId, keys };
		}
	}

	// Hop bookkeeping. A hop = edit/write → run (test/build) → the same failure seen again.
	// Edits mark open chains; a run after an edit makes a pending hop; the pending hops are
	// confirmed when the same failure signature shows up again (so progress never counts).
	let hops = s.hops;
	if (keys.writes.length || keys.run)
		hops = Object.fromEntries(
			Object.entries(hops).map(([k, h]) => {
				const edited = h.edited || keys.writes.length > 0;
				return [k, keys.run && edited ? { ...h, edited: false, pending: h.pending + 1 } : { ...h, edited }];
			}),
		);
	if (keys.fail && cfg.maxHops > 0) {
		const key = `fail:${keys.fail}`;
		const prev = hops[key];
		const fresh = !prev || n - prev.last > cfg.hopGapCalls || n <= (s.quiet[key] ?? 0);
		const cur = fresh ? { hops: 0, from: n, last: n, edited: false, pending: 0 } : { ...prev, hops: prev.hops + prev.pending, pending: 0, last: n };
		hops = { ...hops, [key]: cur };
		if (cur.hops >= cfg.maxHops) {
			const span = entries.filter((e) => e.n >= cur.from);
			const files = new Set<string>();
			for (const e of span) if (e.keys.fail === keys.fail && e.keys.failFile) files.add(e.keys.failFile);
			const sig = [...span].reverse().find((e) => e.keys.fail === keys.fail && e.keys.errLine)?.keys.errLine;
			const target = keys.fail.startsWith("build: ") ? "build error" : `test "${keys.fail}"`;
			const { [key]: _done, ...rest } = hops;
			return {
				state: { ...state, hops: rest, quiet: { ...s.quiet, [key]: n } },
				fire: { kind: "test", key, target, count: span.length, span: span.map((e) => e.toolCallId), files: [...files], sig, at: n, hops: cur.hops },
			};
		}
	}
	state.hops = hops;
	if (cfg.readRepeatThreshold > 0) {
		for (const f of keys.reads) {
			const key = `read:${f}`;
			const win = live(key);
			let lastWrite = -1;
			win.forEach((e, i) => {
				if (e.keys.writes.includes(f)) lastWrite = i;
			});
			const hits = win.slice(lastWrite + 1).filter((e) => e.keys.reads.includes(f));
			if (hits.length >= cfg.readRepeatThreshold) {
				const from = hits[0]!.n;
				const span = entries.filter((e) => e.n >= from);
				return {
					state: { ...state, quiet: { ...s.quiet, [key]: n } },
					fire: { kind: "read", key, target: `file ${f} (re-read ${hits.length}× without changes)`, count: span.length, span: span.map((e) => e.toolCallId), files: [], at: n },
				};
			}
		}
	}
	return { state };
}

// ---- deferred items ---------------------------------------------------------

export interface DeferredItem {
	id: string;
	key: string;
	target: string;
	count: number;
	sig?: string;
	files: string[];
	/** toolCallIds cut out of the context. */
	cut: string[];
	hops?: number;
	status: "deferred" | "unblocked" | "dropped";
	guidance?: string;
	by?: "reviewer" | "user";
}

/** Pure: add a fire to the deferred list (merging repeats of the same key). */
export function deferFire(list: readonly DeferredItem[], f: LoopFire): { list: DeferredItem[]; item: DeferredItem } {
	const prev = list.find((d) => d.key === f.key && d.status === "deferred");
	if (prev) {
		const item: DeferredItem = { ...prev, count: prev.count + f.count, sig: f.sig ?? prev.sig, cut: [...new Set([...prev.cut, ...f.span])], files: [...new Set([...prev.files, ...f.files])], hops: (prev.hops ?? 0) + (f.hops ?? 0) || undefined };
		return { list: list.map((d) => (d === prev ? item : d)), item };
	}
	const item: DeferredItem = { id: `D${list.length + 1}`, key: f.key, target: f.target, count: f.count, sig: f.sig, files: f.files, cut: f.span, hops: f.hops, status: "deferred" };
	return { list: [...list, item], item };
}

export function loopNote(item: DeferredItem, count = item.count): string {
	return `⚠ Loop detected (${item.id}): ${item.hops ? `${item.hops} edit→run→fail hops, ` : ""}${count} calls on ${item.target}${item.sig ? `, error ${item.sig}` : ""}. Something went wrong; this item is DEFERRED until the reviewer or user confirms. Do not continue it; proceed with the next plan step. (Those calls were removed from your context; the journal keeps them.)`;
}

export function renderDeferred(list: readonly DeferredItem[]): string | undefined {
	if (!list.length) return undefined;
	const lines = list.map((d) =>
		d.status === "deferred"
			? `- ${d.id} DEFERRED: ${d.target}${d.sig ? ` — ${d.sig}` : ""} (${d.count} calls). Do not work on it until baton_review or the user unblocks it.`
			: `- ${d.id} ${d.status} by ${d.by ?? "?"}: ${d.target}${d.guidance ? ` — guidance: ${d.guidance}` : ""}`,
	);
	return `Deferred items:\n${lines.join("\n")}`;
}

/** Pure: resolve deferred items (reviewer rulings or user unblock). */
export function resolveDeferred(
	list: readonly DeferredItem[],
	rulings: readonly { id: string; ruling: "unblock" | "drop" | "keep"; guidance?: string }[],
	by: "reviewer" | "user",
): DeferredItem[] {
	return list.map((d) => {
		const r = rulings.find((x) => x.id === d.id || x.id === "all");
		if (!r || r.ruling === "keep" || d.status !== "deferred") return d;
		return { ...d, status: r.ruling === "drop" ? "dropped" : "unblocked", guidance: r.guidance, by };
	});
}

/** Pure: soft block for edit/write of files tied to an active deferred item. */
export function deferredEditGate(tool: string, path: string | undefined, list: readonly DeferredItem[], cfg: LoopConfig): { block: true; reason: string } | undefined {
	if (!cfg.blockDeferredEdits || !path || (tool !== "edit" && tool !== "write")) return undefined;
	const d = list.find((x) => x.status === "deferred" && x.files.includes(path));
	if (!d) return undefined;
	return { block: true, reason: `Baton: ${path} belongs to deferred item ${d.id} (${d.target}). It stays blocked until baton_review rules on it or the user runs /baton unblock ${d.id}. Proceed with the next plan step.` };
}

// ---- context surgery ---------------------------------------------------------

interface Msg {
	role: string;
	content?: unknown;
	toolCallId?: string;
	[k: string]: unknown;
}

/**
 * Pure: remove the tool calls/results of deferred items from the outgoing request. The first
 * call of each item keeps its slot and its result becomes the loop note, so the message
 * structure (every toolCall has a toolResult) stays valid.
 */
export function cutLoops<T extends Msg>(messages: readonly T[], items: readonly DeferredItem[]): { messages: T[]; cut: number } {
	if (!items.length) return { messages: [...messages], cut: 0 };
	const present = new Set<string>();
	for (const m of messages) if (m.role === "toolResult" && m.toolCallId) present.add(m.toolCallId);
	const keepAs = new Map<string, string>();
	const drop = new Set<string>();
	for (const d of items) {
		const ids = d.cut.filter((id) => present.has(id));
		if (!ids.length) continue;
		keepAs.set(ids[0]!, loopNote(d));
		for (const id of ids.slice(1)) drop.add(id);
	}
	if (!drop.size && !keepAs.size) return { messages: [...messages], cut: 0 };
	const out: T[] = [];
	for (const m of messages) {
		if (m.role === "toolResult" && m.toolCallId) {
			if (drop.has(m.toolCallId)) continue;
			const note = keepAs.get(m.toolCallId);
			out.push(note ? ({ ...m, content: [{ type: "text", text: note }], isError: false } as T) : m);
			continue;
		}
		if (m.role === "assistant" && Array.isArray(m.content)) {
			const content = (m.content as Array<Record<string, unknown>>).filter((c) => !(c?.type === "toolCall" && typeof c.id === "string" && drop.has(c.id)));
			if (content.length === m.content.length) out.push(m);
			else if (content.some((c) => c?.type === "toolCall" || (c?.type === "text" && String(c.text ?? "").trim()))) out.push({ ...m, content } as T);
			continue;
		}
		out.push(m);
	}
	return { messages: out, cut: drop.size };
}
