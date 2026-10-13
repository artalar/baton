import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { estimateTokens, headTail, oneLine, sha1, sha256 } from "./util.ts";

export type EventKind = "tool_call" | "user_prompt" | "advisor" | "reset" | "note";

export interface TestSummary {
	cmd: string;
	passed: number;
	failed: number;
	failedNames: string[];
}

export interface JournalEvent {
	evt: number;
	ts: string;
	turn: number;
	kind: EventKind;
	tool?: string;
	toolCallId?: string;
	argsDigest?: string;
	argsHash?: string;
	/** Process exit code for bash; 0/1 for other tools (ok/err). */
	exit?: number | null;
	outTokens?: number;
	outHead?: string;
	outTail?: string;
	errSig?: string | null;
	filesRead?: string[];
	filesWritten?: string[];
	/** path → sha1 of written content (write tool only). */
	fileHashAfter?: Record<string, string>;
	test?: TestSummary | null;
	/** Path of the full raw output, relative to the journal dir. */
	rawRef?: string;
	importance?: 0 | 1 | 2 | 3;
	text?: string;
	data?: unknown;
}

export interface ToolObservation {
	tool: string;
	toolCallId?: string;
	input: Record<string, unknown>;
	output: string;
	isError: boolean;
	exitCode?: number | null;
	turn: number;
	cwd: string;
	now?: Date;
}

const HEAD_LINES = 10;
const TAIL_LINES = 20;
const ERR_HEAD_LINES = 20;

export function normPath(p: string, cwd: string): string {
	const abs = isAbsolute(p) ? p : resolve(cwd, p);
	const rel = relative(cwd, abs);
	return rel && !rel.startsWith("..") ? rel : abs;
}

/** Short, deterministic description of tool arguments. Bodies of write/edit are replaced by hashes. */
export function argsDigest(tool: string, input: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(input)) {
		if (tool === "write" && k === "content" && typeof v === "string") parts.push(`content=sha256:${sha256(v).slice(0, 12)} (${v.length}ch)`);
		else if (tool === "edit" && (k === "edits" || k === "oldText" || k === "newText"))
			parts.push(`${k}=sha256:${sha256(JSON.stringify(v)).slice(0, 12)}`);
		else parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
	}
	return oneLine(parts.join(" "), 200);
}

export function filesFromArgs(tool: string, input: Record<string, unknown>, cwd: string): { read: string[]; written: string[] } {
	const p = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
	if (!p) return { read: [], written: [] };
	const n = normPath(p, cwd);
	if (tool === "read") return { read: [n], written: [] };
	if (tool === "write" || tool === "edit") return { read: [], written: [n] };
	return { read: [], written: [] };
}

/**
 * Normalised error signature: first error-looking line with numbers, hex addresses, quoted
 * values and absolute temp paths replaced, so that repeats of the same failure collide.
 */
export function errorSignature(output: string, isError: boolean): string | null {
	const lines = output.split("\n");
	const pat = /(error|exception|traceback|failed|fatal|panic|cannot|not found|undefined|segmentation)/i;
	const line = lines.find((l) => pat.test(l) && !/^\s*(\d+ )?(passed|tests?:)/i.test(l)) ?? (isError ? lines.find((l) => l.trim()) : undefined);
	if (!line) return null;
	const loc = output.match(/([\w./-]+\.\w+):(\d+)/);
	const norm = line
		.replace(/0x[0-9a-f]+/gi, "0x#")
		.replace(/(["'`]).*?\1/g, "$1…$1")
		.replace(/\d+(\.\d+)?/g, "#")
		.replace(/\/tmp\/\S+/g, "/tmp/…")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
	return loc ? `${norm} @${loc[1]}` : norm;
}

const TEST_CMD = /\b(vitest|jest|mocha|pytest|go test|cargo test|npm (run )?test|pnpm (run )?test|yarn test|bun test|deno test|rspec|phpunit)\b/;

/** Parse common test-runner summaries. Returns null for non-test commands. */
export function parseTestSummary(cmd: string, output: string): TestSummary | null {
	if (!TEST_CMD.test(cmd)) return null;
	let passed = 0;
	let failed = 0;
	const num = (re: RegExp) => {
		const m = output.match(re);
		return m ? Number(m[1]) : 0;
	};
	// vitest / jest: "Tests  2 failed | 5 passed (7)" / "Tests: 1 failed, 4 passed, 5 total"
	const vt = output.match(/Tests?:?\s+(.*)$/m);
	if (vt) {
		passed = num(/Tests?:?\s+.*?(\d+) passed/m);
		failed = num(/Tests?:?\s+.*?(\d+) failed/m);
	}
	if (!vt || (passed === 0 && failed === 0)) {
		// pytest "=== 3 failed, 10 passed in 1.2s ===", cargo "test result: ok. 5 passed; 0 failed"
		passed = num(/(\d+) passed/);
		failed = num(/(\d+) failed/);
	}
	if (/^(ok|PASS)\s/m.test(output) && passed === 0 && failed === 0 && /go test/.test(cmd)) passed = (output.match(/^ok\s/gm) ?? []).length;
	if (/^FAIL\s/m.test(output) && failed === 0 && /go test/.test(cmd)) failed = (output.match(/^FAIL\s/gm) ?? []).length;
	const names = new Set<string>();
	for (const m of output.matchAll(/^\s*(?:FAIL|×|✗|✕|FAILED)\s+(.+?)\s*$/gm)) {
		names.add(oneLine(m[1]!, 160));
		if (names.size >= 20) break;
	}
	return { cmd: oneLine(cmd, 200), passed, failed, failedNames: [...names] };
}

/** B.2 heuristics. `seenSigs` are error signatures already in the journal. */
export function heuristicImportance(e: JournalEvent, seenSigs: ReadonlySet<string>): 0 | 1 | 2 | 3 {
	if (e.kind === "user_prompt" || e.kind === "advisor") return 3;
	if (e.tool === "write" || e.tool === "edit") return 3;
	if (e.errSig) {
		if (/(command not found|permission denied|ENOENT|No such file)/i.test(e.errSig)) return 2;
		return seenSigs.has(e.errSig) ? 2 : 3;
	}
	if (e.test) return e.test.failed > 0 ? 2 : 1;
	if (e.tool === "ls" || e.tool === "find" || e.tool === "grep") return 0;
	if (e.tool === "read") return 1;
	return 1;
}

/** Pure: build a journal record from a tool observation (raw output is stored separately). */
export function buildToolEvent(evt: number, o: ToolObservation, seenSigs: ReadonlySet<string>): JournalEvent {
	const isErr = o.isError || (o.exitCode !== undefined && o.exitCode !== null && o.exitCode !== 0);
	const lines = o.output.split("\n");
	const head = isErr ? ERR_HEAD_LINES : HEAD_LINES;
	const outHead = lines.slice(0, head).join("\n");
	const outTail = lines.length > head ? lines.slice(Math.max(head, lines.length - TAIL_LINES)).join("\n") : "";
	const files = filesFromArgs(o.tool, o.input, o.cwd);
	const fileHashAfter: Record<string, string> = {};
	if (o.tool === "write" && typeof o.input.content === "string" && files.written[0]) fileHashAfter[files.written[0]] = sha1(o.input.content);
	const cmd = typeof o.input.command === "string" ? o.input.command : "";
	const e: JournalEvent = {
		evt,
		ts: (o.now ?? new Date()).toISOString(),
		turn: o.turn,
		kind: "tool_call",
		tool: o.tool,
		toolCallId: o.toolCallId,
		argsDigest: argsDigest(o.tool, o.input),
		argsHash: sha1(JSON.stringify(o.input)),
		exit: o.exitCode !== undefined ? o.exitCode : isErr ? 1 : 0,
		outTokens: estimateTokens(o.output),
		outHead: outHead.slice(0, 1500),
		outTail: outTail.slice(0, 2500),
		errSig: isErr ? errorSignature(o.output, true) : null,
		filesRead: files.read,
		filesWritten: files.written,
		fileHashAfter: Object.keys(fileHashAfter).length ? fileHashAfter : undefined,
		test: cmd ? parseTestSummary(cmd, o.output) : null,
		rawRef: `raw/${evt}.txt`,
	};
	e.importance = heuristicImportance(e, seenSigs);
	return e;
}

/** One-line rendering used in stubs, timelines and recall headers. */
export function eventLine(e: JournalEvent): string {
	if (e.kind !== "tool_call") return `evt#${e.evt} ${e.kind}: ${oneLine(e.text ?? "", 160)}`;
	const t = e.test ? ` tests ${e.test.passed}✓/${e.test.failed}✗` : "";
	const err = e.errSig ? ` err: ${e.errSig}` : "";
	return `evt#${e.evt} ${e.tool} ${e.argsDigest ?? ""} → exit ${e.exit}, ${e.outTokens ?? 0} tok${t}${err}`;
}

/** Append-only journal on disk: <dir>/events.jsonl + <dir>/raw/<evt>.txt. */
export class Journal {
	readonly dir: string;
	events: JournalEvent[] = [];
	private byCall = new Map<string, JournalEvent>();

	constructor(dir: string) {
		this.dir = dir;
		mkdirSync(join(dir, "raw"), { recursive: true });
		const file = join(dir, "events.jsonl");
		if (existsSync(file)) {
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					this.index(JSON.parse(line) as JournalEvent);
				} catch {
					/* skip corrupt line */
				}
			}
		}
	}

	private index(e: JournalEvent) {
		this.events.push(e);
		if (e.toolCallId) this.byCall.set(e.toolCallId, e);
	}

	nextEvt(): number {
		return (this.events.at(-1)?.evt ?? 0) + 1;
	}

	errorSigs(): Set<string> {
		return new Set(this.events.flatMap((e) => (e.errSig ? [e.errSig] : [])));
	}

	recordTool(o: ToolObservation): JournalEvent {
		const e = buildToolEvent(this.nextEvt(), o, this.errorSigs());
		writeFileSync(join(this.dir, e.rawRef!), o.output);
		this.append(e);
		return e;
	}

	record(kind: EventKind, turn: number, text: string, data?: unknown): JournalEvent {
		const e: JournalEvent = { evt: this.nextEvt(), ts: new Date().toISOString(), turn, kind, text, data, importance: 3 };
		this.append(e);
		return e;
	}

	private append(e: JournalEvent) {
		appendFileSync(join(this.dir, "events.jsonl"), `${JSON.stringify(e)}\n`);
		this.index(e);
	}

	get(evt: number): JournalEvent | undefined {
		return this.events.find((e) => e.evt === evt);
	}

	forCall(toolCallId: string): JournalEvent | undefined {
		return this.byCall.get(toolCallId);
	}

	raw(evt: number): string | undefined {
		const e = this.get(evt);
		if (!e?.rawRef) return undefined;
		const p = join(this.dir, e.rawRef);
		return existsSync(p) ? readFileSync(p, "utf8") : undefined;
	}

	toolEvents(): JournalEvent[] {
		return this.events.filter((e) => e.kind === "tool_call");
	}
}

export { headTail };
