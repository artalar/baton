import type { DeferredItem } from "./loop.ts";
import { type JournalEvent, eventLine, normPath } from "./journal.ts";
import { matchesAny } from "./util.ts";

/** Minimal structural view of pi's AgentMessage that masking needs. */
export interface MsgLike {
	role: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	[k: string]: unknown;
}

export interface MaskOptions {
	enabled: boolean;
	exemptTools: string[];
	dedupReads: boolean;
	staleReads: boolean;
	cwd: string;
	/** Reads of these paths (skills, reference docs) are never masked, deduped or marked stale. */
	neverMaskPaths?: string[];
}

const BASH_READ = /^\s*(cat|head|tail|sed|less|more|bat|nl|awk)\b/;

/** Pure: is this tool call a read of a skill / reference doc that must stay visible? */
export function isReferenceRead(tool: string, args: Record<string, unknown> | undefined, cwd: string, globs: readonly string[] | undefined): boolean {
	if (!globs?.length || !args) return false;
	if (tool === "read") {
		const p = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
		return !!p && matchesAny(normPath(p, cwd), globs);
	}
	if (tool === "bash" && typeof args.command === "string") {
		// only simple read pipelines: every segment must be a read command, every path arg a reference doc
		const segs = args.command.split(/&&|;|\|\|/).map((x) => x.trim()).filter(Boolean);
		if (!segs.length) return false;
		let paths = 0;
		for (const seg of segs) {
			if (!BASH_READ.test(seg)) return false;
			for (const tok of seg.split(/\s+/).slice(1)) {
				if (tok.startsWith("-") || /^[|>]/.test(tok) || /^\d+$/.test(tok) || /^['"]?\d*,?\d*p['"]?$/.test(tok)) continue;
				const t = tok.replace(/^['"]|['"]$/g, "");
				if (!t.includes("/") && !t.includes(".")) continue;
				if (!matchesAny(normPath(t, cwd), globs)) return false;
				paths++;
			}
		}
		return paths > 0;
	}
	return false;
}

/**
 * Pure: append the pinned plan to the first user message of the request (stable position, so the
 * provider prompt cache only breaks when the plan itself changes). Never masked: masking only touches toolResult.
 */
export function pinPlan<T extends MsgLike>(messages: readonly T[], planText: string | undefined): T[] {
	if (!planText) return [...messages];
	const i = messages.findIndex((m) => m.role === "user");
	if (i < 0) return [...messages];
	const m = messages[i]!;
	const block = { type: "text", text: `<baton_pinned_plan>\n${planText}\n</baton_pinned_plan>` };
	const content = typeof m.content === "string" ? [{ type: "text", text: m.content }, block] : Array.isArray(m.content) ? [...m.content, block] : [block];
	const out = [...messages];
	out[i] = { ...m, content } as T;
	return out;
}

export interface MaskStats {
	masked: number;
	deduped: number;
	stale: number;
	charsSaved: number;
}

type Lookup = (toolCallId: string) => JournalEvent | undefined;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "")).join("\n");
}

export function stubText(kind: "masked" | "duplicate" | "stale", toolName: string, e: JournalEvent | undefined, ref?: number): string {
	const head = e ? eventLine(e) : `${toolName} (no journal record)`;
	const recall = e ? ` baton_recall({"evt":${e.evt}}) returns the full output.` : "";
	if (kind === "duplicate") return `[baton: duplicate read, superseded by evt#${ref}. ${head}.${recall}]`;
	if (kind === "stale") return `[baton: stale read, file changed at evt#${ref}. ${head}.${recall}]`;
	return `[baton: output masked. ${head}.${recall}]`;
}

/**
 * Pure. Returns new messages where:
 * - every tool result that the model has already answered (i.e. followed by an assistant
 *   message) is replaced by a stub that references its evt#;
 * - earlier reads of the same file/range are replaced by "duplicate" stubs;
 * - reads followed by a write/edit of the same file are replaced by "stale" stubs.
 * Results of the current, unanswered batch stay visible (unless duplicate/stale).
 * The session itself is not modified: pi only applies this to the outgoing request.
 */
export function maskMessages<T extends MsgLike>(messages: readonly T[], lookup: Lookup, opts: MaskOptions): { messages: T[]; stats: MaskStats } {
	const stats: MaskStats = { masked: 0, deduped: 0, stale: 0, charsSaved: 0 };
	if (!opts.enabled) return { messages: [...messages], stats };

	// toolCallId -> arguments, from assistant tool calls
	const args = new Map<string, Record<string, unknown>>();
	let lastAssistant = -1;
	messages.forEach((m, i) => {
		if (m.role !== "assistant") return;
		lastAssistant = i;
		if (!Array.isArray(m.content)) return;
		for (const c of m.content as Array<Record<string, unknown>>) {
			if (c?.type === "toolCall" && typeof c.id === "string") args.set(c.id, (c.arguments as Record<string, unknown>) ?? {});
		}
	});

	const pathOf = (a: Record<string, unknown> | undefined) => {
		const p = a && (typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : undefined);
		return p ? normPath(p, opts.cwd) : undefined;
	};
	const evtOf = (m: T, i: number) => (m.toolCallId ? lookup(m.toolCallId) : undefined)?.evt ?? -(i + 1);

	// latest read index per (path, range) and latest write index per path
	const lastRead = new Map<string, number>();
	const writesAfter = new Map<string, number[]>();
	messages.forEach((m, i) => {
		if (m.role !== "toolResult" || !m.toolCallId) return;
		const a = args.get(m.toolCallId);
		const p = pathOf(a);
		if (!p) return;
		if (m.toolName === "read") lastRead.set(`${p}#${a?.offset ?? ""}:${a?.limit ?? ""}`, i);
		if (m.toolName === "write" || m.toolName === "edit") writesAfter.set(p, [...(writesAfter.get(p) ?? []), i]);
	});

	const out = messages.map((m, i) => {
		if (m.role !== "toolResult") return m;
		const name = m.toolName ?? "tool";
		if (opts.exemptTools.includes(name)) return m;
		const e = m.toolCallId ? lookup(m.toolCallId) : undefined;
		const a = m.toolCallId ? args.get(m.toolCallId) : undefined;
		if (isReferenceRead(name, a, opts.cwd, opts.neverMaskPaths)) return m;
		let stub: string | undefined;
		if (name === "read") {
			const p = pathOf(a);
			if (p) {
				const key = `${p}#${a?.offset ?? ""}:${a?.limit ?? ""}`;
				const later = lastRead.get(key);
				const w = (writesAfter.get(p) ?? []).find((wi) => wi > i);
				if (opts.staleReads && w !== undefined) {
					stub = stubText("stale", name, e, evtOf(messages[w]!, w));
					stats.stale++;
				} else if (opts.dedupReads && later !== undefined && later > i) {
					stub = stubText("duplicate", name, e, evtOf(messages[later]!, later));
					stats.deduped++;
				}
			}
		}
		if (!stub && i < lastAssistant) {
			stub = stubText("masked", name, e);
			stats.masked++;
		}
		if (!stub) return m;
		const before = textOf(m.content).length;
		if (before <= stub.length && !/(duplicate|stale)/.test(stub)) {
			// tiny output: masking would not save anything; keep it
			stats.masked--;
			return m;
		}
		stats.charsSaved += Math.max(0, before - stub.length);
		return { ...m, content: [{ type: "text", text: stub }] } as T;
	});
	return { messages: out, stats };
}

/**
 * Snapshot taken at a handoff (advisor call). Everything the executor saw before it is frozen:
 * tool outputs in `stub` are replaced by evt# stubs, deferred loop calls in `cut` are cut out.
 * Messages after the handoff are never touched until the next handoff.
 */
export interface HandoffSnapshot {
	/** Monotonic handoff number (1, 2, …). */
	n: number;
	/** toolCallIds whose outputs are replaced by stubs. */
	stub: string[];
	/** Deferred items whose looping calls are cut (only calls already in `stub`/before the handoff). */
	cut: DeferredItem[];
}

/**
 * Pure: the snapshot for a handoff. `calls` are the toolCallIds of all non-Baton tool calls so far,
 * in order; the last `keepLast` stay verbatim (help keeps its last N calls), all older ones get stubs.
 */
export function handoffSnapshot(n: number, calls: readonly string[], keepLast: number, deferred: readonly DeferredItem[]): HandoffSnapshot {
	const keep = Math.max(0, keepLast);
	const stub = keep > 0 ? calls.slice(0, Math.max(0, calls.length - keep)) : [...calls];
	const before = new Set(calls);
	return { n, stub, cut: deferred.filter((d) => d.status === "deferred").map((d) => ({ ...d, cut: d.cut.filter((id) => before.has(id)) })).filter((d) => d.cut.length) };
}

/**
 * Pure: apply a handoff snapshot to the outgoing messages. Deterministic and depends only on the
 * snapshot, so the request prefix stays identical between handoffs (no on-the-fly masking).
 * Exempt tools and reference reads (skills, docs) are never stubbed; tiny outputs are kept.
 */
export function applyHandoff<T extends MsgLike>(messages: readonly T[], snap: HandoffSnapshot | undefined, lookup: Lookup, opts: MaskOptions): { messages: T[]; stats: MaskStats } {
	const stats: MaskStats = { masked: 0, deduped: 0, stale: 0, charsSaved: 0 };
	if (!snap || !opts.enabled) return { messages: [...messages], stats };
	const ids = new Set(snap.stub);
	const args = new Map<string, Record<string, unknown>>();
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const c of m.content as Array<Record<string, unknown>>) if (c?.type === "toolCall" && typeof c.id === "string") args.set(c.id, (c.arguments as Record<string, unknown>) ?? {});
	}
	const out = messages.map((m) => {
		if (m.role !== "toolResult" || !m.toolCallId || !ids.has(m.toolCallId)) return m;
		const name = m.toolName ?? "tool";
		if (opts.exemptTools.includes(name)) return m;
		if (isReferenceRead(name, args.get(m.toolCallId), opts.cwd, opts.neverMaskPaths)) return m;
		const stub = stubText("masked", name, lookup(m.toolCallId));
		const before = textOf(m.content).length;
		if (before <= stub.length) return m;
		stats.masked++;
		stats.charsSaved += before - stub.length;
		return { ...m, content: [{ type: "text", text: stub }] } as T;
	});
	return { messages: out, stats };
}
