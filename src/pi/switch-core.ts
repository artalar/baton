/**
 * Baton "switch" mode — pure core. One pi session, the lead model (Opus) owns planning and code; a cheap helper
 * model (GLM) runs the reading, verify/debug and final-review stretches. All decisions here are deterministic and
 * side-effect free; src/pi/switch.ts wires them to pi events (tool_call gate, turn_end switch, context shaping).
 */

export type Phase = "read" | "lead" | "followup" | "debug" | "review" | "final" | "done";
export const HELPER_PHASES: readonly Phase[] = ["read", "followup", "debug", "review"];
export const isHelper = (p: Phase) => HELPER_PHASES.includes(p);

export interface SwitchConfig {
	lead: string;
	helper: string;
	/** Follow-up read rounds the lead may delegate. */
	maxFollowups: number;
	/** Red cycles (edit → verify → same failure) before the helper escalates to the lead. */
	redCycles: number;
	/** Any red cycles in one debug stretch before escalation. */
	maxRedTotal: number;
	/** Helper stretch wall-clock cap (Anthropic prompt cache TTL is 5 min). */
	maxHelperMs: number;
	/** Tool-call caps per helper stretch. */
	maxReadCalls: number;
	maxFollowupCalls: number;
	/** Helper assistant text longer than this in a reading stretch = it started reasoning → hand back. */
	readTextChars: number;
	/** Reasoning cap for lead turns outside planning (OpenRouter reasoning.max_tokens; 0 = no cap). */
	thinkingCap: number;
	/** Lead turns with full thinking after a read handoff / escalation. */
	planningTurns: number;
	/** Optional short final check by the lead after the helper's review. */
	finalCheck: boolean;
	/** Retries of empty 200 responses from the lead. */
	emptyRetries: number;
	/** Cap on the lead's max output tokens per request (also keeps OpenRouter's credit pre-check small). */
	leadMaxTokens: number;
	/** Read outputs longer than this are clipped at handoff compaction. */
	clipChars: number;
	/** max_tokens on lead turns that are neither planning nor expected writes (thinking cap enforced; 0 = off). */
	nonWriteMaxTokens: number;
	/** Budget stop (USD, 0 = off): lead cost exact + helper cost × helperCostFactor + reserveUsd ≥ budgetUsd → stop. */
	budgetUsd: number;
	helperCostFactor: number;
	reserveUsd: number;
	/** Max chars of helper read outputs carried in one honest harness report. */
	reportChars: number;
}

export const DEFAULT_SWITCH: SwitchConfig = {
	lead: "openrouter/anthropic/claude-opus-5.5",
	helper: "openrouter/z-ai/glm-5.3-flash",
	maxFollowups: 2,
	redCycles: 6,
	maxRedTotal: 12,
	maxHelperMs: 270_000,
	maxReadCalls: 30,
	maxFollowupCalls: 12,
	readTextChars: 300,
	thinkingCap: 1024,
	planningTurns: 1,
	finalCheck: true,
	emptyRetries: 3,
	clipChars: 20_000,
	leadMaxTokens: 16_000,
	nonWriteMaxTokens: 6_000,
	budgetUsd: 0,
	helperCostFactor: 2.3,
	reserveUsd: 0.5,
	reportChars: 160_000,
};

export interface Call {
	id: string;
	name: string;
	args: Record<string, unknown>;
}
export interface Result {
	id: string;
	isError: boolean;
	text: string;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "glob"]);
const READ_CMD = /^(ls|cat|head|tail|wc|tree|find|grep|rg|fd|file|stat|pwd|echo|nl|less|more|sort|uniq|cut|awk|jq|du|sed\s+-n|git\s+(-C\s+\S+\s+)?(status|log|diff|show|ls-files|branch|rev-parse)|npm\s+(ls|view|info)|node\s+(-v|--version)|npx\s+tsc\s+--version)\b/;

/** Pure: a read-only tool call (read/grep/find/ls, or a bash pipeline of read commands without redirects). */
export function isReadOnly(c: Pick<Call, "name" | "args">): boolean {
	if (READ_TOOLS.has(c.name)) return true;
	if (c.name !== "bash") return false;
	const cmd = typeof c.args.command === "string" ? c.args.command : "";
	if (!cmd.trim() || /(^|[^2&])>|>>|\btee\b|\$\(|`/.test(cmd.replace(/2>&1|2>\/dev\/null|>\s*\/dev\/null/g, ""))) return false;
	const segs = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim().replace(/^cd\s+\S+\s*$/, "pwd")).filter(Boolean);
	return segs.length > 0 && segs.every((s) => READ_CMD.test(s));
}

/**
 * Pure: the command segments that actually execute. Heredoc bodies and quoted strings are removed (file contents
 * written with `cat > f <<'EOF' … EOF` or `node -e '…'` must not count — arm D, T18: "tsc && vite build" inside a
 * heredoc'd package.json flipped the lead into debug), then the command is split at && || ; | newlines and subshells.
 */
export function executedSegments(cmd: string): string[] {
	let s = cmd.replace(/\\\n/g, " ");
	s = s.replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, (_m, _q, _t, rest: string) => ` ${rest}`);
	s = s.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
	return s
		.split(/&&|\|\||;|\||\n|\(|\)/)
		.map((x) =>
			x
				.trim()
				.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")
				.replace(/^(?:timeout\s+(?:-\S+\s+)*\S+\s+|time\s+|env\s+)/, "")
				.trim(),
		)
		.filter(Boolean);
}

const RUNNER = "(?:(?:npx|bunx|pnpm\\s+(?:exec|dlx)|yarn(?:\\s+exec)?)\\s+(?:-\\S+\\s+)*)?";
const TEST_START = new RegExp(`^${RUNNER}(?:vitest|jest|mocha|playwright\\s+test)\\b|^node\\s+--test\\b|^(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test\\b`);
const TSC_START = new RegExp(`^${RUNNER}(?:tsc|vue-tsc)\\b|^(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:typecheck|check)\\b`);
const BUILD_START = new RegExp(`^${RUNNER}vite\\s+build\\b|^(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?build\\b`);
const LINT_START = new RegExp(`^${RUNNER}(?:eslint|biome)\\b|^(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?lint\\b`);
export type VerifyKind = "test" | "tsc" | "build" | "lint";

/** Pure: which verify kinds a bash call runs (only executed segments; `--version` probes excluded). */
export function verifyKinds(c: Pick<Call, "name" | "args">): VerifyKind[] {
	if (c.name !== "bash" || typeof c.args.command !== "string") return [];
	const out = new Set<VerifyKind>();
	for (const seg of executedSegments(c.args.command)) {
		if (/\s--version\b|\s-v$/.test(seg)) continue;
		if (TEST_START.test(seg)) out.add("test");
		else if (TSC_START.test(seg)) out.add("tsc");
		else if (BUILD_START.test(seg)) out.add("build");
		else if (LINT_START.test(seg)) out.add("lint");
	}
	return [...out];
}
/** Pure: a verify run (tests / typecheck / build / lint) — executed commands only. */
export function isVerify(c: Pick<Call, "name" | "args">): boolean {
	return verifyKinds(c).length > 0;
}
export const isTestRun = (c: Pick<Call, "name" | "args">) => verifyKinds(c).includes("test");
export const TEST_FILE = /(^|\/)[^/]*\.(test|spec)\.[cm]?[jt]sx?$/;

const isEdit = (c: Call) => c.name === "edit" || c.name === "write";

/** Pure: a stable signature of a failing run (error-ish lines, numbers/durations/paths' line:col normalised). */
export function failSignature(text: string): string {
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => /(error|fail|✗|×|assert|expected|exception|TS\d{4})/i.test(l) && !/^(Tests?|Test Files|Duration|Start at)\b/i.test(l));
	return lines
		.slice(0, 3)
		.map((l) => l.replace(/\d+(\.\d+)?\s*m?s\b/g, "<t>").replace(/:\d+:\d+/g, ":<l>").replace(/\d+/g, "<n>").slice(0, 160))
		.join(" | ");
}

export interface SwitchEvent {
	turn: number;
	from: Phase;
	to: Phase;
	reason: string;
	ts: number;
}

/** A guardrail hit by the helper (blocked or flagged) — surfaced to the lead as SUSPICIOUS EDITS. */
export interface Flag {
	phase: Phase;
	tool: string;
	path?: string;
	why: string;
	blocked: boolean;
}

export interface SwitchMetrics {
	/** Lead calls of baton tools (delegate_reads / baton_delegate / baton_optimize) — never instructed, self-initiated. */
	selfBaton: number;
	selfBatonByTool: Record<string, number>;
	/** Lead re-verification of helper work: verify reruns / reads of helper-touched files right after a helper handback. */
	reverifyRuns: number;
	reverifyReads: number;
	guardBlocks: number;
	/** Lead turns that hit the output cap (length) and were continued. */
	lengthStops: number;
}

export interface SwitchState {
	phase: Phase;
	stretchStart: number;
	stretchCalls: number;
	followups: number;
	leadEditsInStretch: number;
	helperEditsInStretch: number;
	editedSinceVerify: boolean;
	red: { sig: string; same: number; total: number };
	lastVerifyGreen: boolean;
	finalDone: boolean;
	reviewDone: boolean;
	/** The lead said it is finished and handed over to verification. */
	leadFinished: boolean;
	emptyStreak: number;
	/** Pending full-thinking planning: consumed by the first lead turn that writes code (edit/write). */
	planningLeft: number;
	/** The lead itself ran a test command at least once. */
	leadRanTests: boolean;
	/** The "write tests first" nudge was sent. */
	testsNudged: boolean;
	/** The previous lead turn wrote code / hit the output cap (drives the non-write max_tokens cap). */
	lastLeadWrote: boolean;
	lastLeadLength: boolean;
	/** Set by the tool_call gate: the helper tried something outside its phase. */
	wantLead?: string;
	/** Helper calls blocked by the gate (removed from the lead's view). */
	blocked: string[];
	/** Read calls seen: id → normalised path (for dedup at compaction). */
	reads: [string, string][];
	/** Read calls of the current helper stretch (only these may be compacted: older content is in the lead's prompt cache). */
	stretchReads: string[];
	/** Verify calls in the current helper stretch. */
	stretchVerifies: string[];
	/** Honest-handoff material of the current helper stretch. */
	stretchOutputs: { label: string; text: string }[];
	stretchEdits: { path: string; intent: string }[];
	stretchChecks: Partial<Record<VerifyKind, { cmd: string; ok: boolean; tail: string }>>;
	stretchFlags: Flag[];
	lastHelperText: string;
	/** All guardrail hits of the session. */
	flags: Flag[];
	/** Files the helper edited (for re-verification metrics). */
	helperTouched: string[];
	/** Open right after a debug/review handback until the lead's first edit. */
	reverifyOpen: boolean;
	metrics: SwitchMetrics;
	/** Frozen compaction: toolCallId → stub text. Grows only at handoffs to the lead. */
	stubs: Record<string, string>;
	/** Clipped outputs: toolCallId → max chars. */
	clips: Record<string, number>;
	switches: SwitchEvent[];
}

export function initialSwitchState(now: number): SwitchState {
	return {
		phase: "read",
		stretchStart: now,
		stretchCalls: 0,
		followups: 0,
		leadEditsInStretch: 0,
		helperEditsInStretch: 0,
		editedSinceVerify: false,
		red: { sig: "", same: 0, total: 0 },
		lastVerifyGreen: false,
		finalDone: false,
		reviewDone: false,
		leadFinished: false,
		emptyStreak: 0,
		planningLeft: 0,
		leadRanTests: false,
		testsNudged: false,
		lastLeadWrote: false,
		lastLeadLength: false,
		blocked: [],
		reads: [],
		stretchReads: [],
		stretchVerifies: [],
		stretchOutputs: [],
		stretchEdits: [],
		stretchChecks: {},
		stretchFlags: [],
		lastHelperText: "",
		flags: [],
		helperTouched: [],
		reverifyOpen: false,
		metrics: { selfBaton: 0, selfBatonByTool: {}, reverifyRuns: 0, reverifyReads: 0, guardBlocks: 0, lengthStops: 0 },
		stubs: {},
		clips: {},
		switches: [],
	};
}

export const BATON_TOOLS = ["delegate_reads", "baton_delegate", "baton_optimize"] as const;

/** Short, neutral description of the harness tools for the lead's system prompt (no instruction to use them). */
export const LEAD_SYSTEM_NOTE = `

# Baton harness
This session runs under Baton: a cheaper helper model may perform some steps (reading, running checks and small fixes, final review); you will then see an honest "[Baton harness]" report of what it did. Available harness tools: baton_delegate({kind:"reads"|"debug", instruction}) hands file reading, or the verify/fix loop, to the helper; baton_optimize({}) drops superseded read outputs from your context (one cache rewrite). delegate_reads({instruction}) = baton_delegate kind "reads".`;

export const MSG = {
	read: "[baton switch → helper: reading] Explore the repository and the project skills with read-only tools (read, ls, grep, find, or read-only bash such as cat/ls/rg/git log). Read everything the lead model will need to plan and write the code. Do NOT write code, edit files or explain at length. When you have read enough, reply only: READ DONE.",
	followup: (instr: string) =>
		`[baton switch → helper: follow-up reads] The lead model asks you to read: ${instr}\nUse read-only tools only, read exactly what is needed, do not explain. Then reply only: READ DONE.`,
	debug:
		"[baton switch → helper: verify/debug] Run the project's checks (typecheck, tests, build) and fix failures with small, targeted edits to existing files. Do not create new files, do not redesign, do not write long explanations. Forbidden: --passWithNoTests, `as unknown as` casts, downgrading package versions, skipping/deleting/weakening tests. Before each edit write ONE short line saying what the edit does. When typecheck, tests and build are green, stop immediately (no exploratory or fuzz scripts) and reply only: GREEN. If a fix needs new files, a design change or a forbidden step, reply only: ESCALATE <one line why>.",
	review:
		"[baton switch → helper: final review] Review the whole change (git status, git diff, run typecheck/tests/build once) against the user's task. Fix only clear, small bugs (same restrictions as before: no skipped tests, no `as unknown as`, no version downgrades). Then reply with a short list of remaining issues (or NONE).",
	lead: (why: string, report: string) =>
		`${report ? `${report}\n\n` : ""}[baton switch → lead] ${why}\nYou lead: plan briefly and write the code (edit/write). Write the tests together with the code and run them yourself once.`,
	final: (report: string) => `${report}\n\n[baton switch → lead: final check] Do a SHORT final check. Fix only real problems; otherwise reply DONE in one line.`,
	noTests: "[baton switch → lead] There are no test files yet and you have not run tests. Write the tests for your code now (and run them once) before handing over to verification.",
	lengthStop: "[baton switch → lead] Your previous response hit the output token cap and was cut off. Continue exactly where it stopped (re-issue the cut tool call if any).",
};

export interface TurnInput {
	turn: number;
	now: number;
	text: string;
	calls: Call[];
	results: Result[];
	empty: boolean;
	/** The response stopped at max_tokens. */
	lengthStop?: boolean;
	/** Test files exist in the project (checked by the caller). */
	testsExist?: boolean;
	/** `git diff --stat` (lazy; called only at a debug/review → lead handback). */
	diffStat?: () => string;
}

export interface Decision {
	to: Phase;
	reason?: string;
	/** Instruction message to inject (customType decides who sees it). */
	message?: { audience: "helper" | "lead"; text: string };
	/** Ask pi for one more model request (the turn had no tool calls). */
	continue?: boolean;
	/** Compaction applied at this handoff (helper → lead). */
	compacted?: { stubbed: number; clipped: number };
	/** Size of the honest harness report attached at a helper → lead handoff. */
	report?: { chars: number; edits: number; flags: number; outputs: number };
}

function stub(why: string): string {
	return `[baton switch: output compacted at handoff (${why}) — rerun the command or re-read the file if you need it]`;
}

/** Pure: freeze compaction for a helper → lead handoff. Mutates the given (copied) state. */
export function compactAtHandoff(s: SwitchState, from: Phase, cfg: SwitchConfig): { stubbed: number; clipped: number } {
	let stubbed = 0;
	let clipped = 0;
	// Only the stretch being handed over is compacted: everything older was already sent to the lead and
	// sits in its prompt cache — rewriting it would break the cached prefix (observed: a $0.50 cache miss).
	const fresh = new Set(s.stretchReads);
	const reads = s.reads.filter(([id]) => fresh.has(id));
	// duplicate reads of one path within the stretch: keep the latest
	const last = new Map<string, string>();
	for (const [id, p] of reads) last.set(p, id);
	for (const [id, p] of reads) {
		if (last.get(p) !== id && !s.stubs[id]) {
			s.stubs[id] = stub(`superseded by a later read of ${p}`);
			stubbed++;
		}
	}
	for (const [id] of reads) {
		if (!s.stubs[id] && s.clips[id] === undefined) {
			s.clips[id] = cfg.clipChars;
			clipped++;
		}
	}
	// debug stretch: keep only the last two verify outputs
	if (from === "debug" || from === "review") {
		for (const id of s.stretchVerifies.slice(0, -2)) {
			if (!s.stubs[id]) {
				s.stubs[id] = stub("older verify run of the helper's fix loop");
				stubbed++;
			}
		}
	}
	return { stubbed, clipped };
}

/** Pure: baton_optimize — stub every superseded read (any model), clip remaining read outputs. One cache rewrite. */
export function optimizeContext(s: SwitchState, clip = 4000): { stubbed: number; clipped: number } {
	let stubbed = 0;
	let clipped = 0;
	const last = new Map<string, string>();
	for (const [id, p] of s.reads) last.set(p, id);
	for (const [id, p] of s.reads) {
		if (s.stubs[id]) continue;
		if (last.get(p) !== id) {
			s.stubs[id] = stub(`superseded by a later read of ${p}; baton_optimize`);
			stubbed++;
		} else if (s.clips[id] === undefined || s.clips[id]! > clip) {
			s.clips[id] = clip;
			clipped++;
		}
	}
	return { stubbed, clipped };
}

function readPath(c: Call): string | undefined {
	if (c.name === "read") {
		const p = c.args.path ?? c.args.file_path;
		return typeof p === "string" ? p.replace(/^\.\//, "") : undefined;
	}
	if (c.name === "bash" && typeof c.args.command === "string") {
		const m = /^\s*cat\s+([^\s|;&]+)\s*$/.exec(c.args.command);
		return m?.[1]?.replace(/^\.\//, "");
	}
	return undefined;
}

const editPath = (c: Call) => {
	const p = c.args.path ?? c.args.file_path;
	return typeof p === "string" ? p.replace(/^\.\//, "") : "";
};
const editPairs = (c: Call): { oldText: string; newText: string }[] => {
	if (c.name === "write") return [{ oldText: "", newText: String(c.args.content ?? "") }];
	const edits = Array.isArray(c.args.edits) ? (c.args.edits as { oldText?: string; newText?: string }[]) : [{ oldText: c.args.oldText as string, newText: c.args.newText as string }];
	return edits.map((e) => ({ oldText: String(e.oldText ?? ""), newText: String(e.newText ?? "") }));
};
const count = (t: string, re: RegExp) => (t.match(re) ?? []).length;
const TEST_CASE = /\b(?:it|test)(?:\.each\([^)]*\))?\s*\(/g;
const SKIP = /\b(?:it|test|describe)\.(?:skip|todo)\b|\bx(?:it|describe|test)\s*\(|\.only\s*\(/g;

function versions(text: string): Map<string, number[]> {
	const m = new Map<string, number[]>();
	for (const [, name, v] of text.matchAll(/"([@\w./-]+)"\s*:\s*"[~^>=]*(\d+(?:\.\d+){0,2})[^"]*"/g)) m.set(name!, v!.split(".").map(Number));
	return m;
}
const lower = (a: number[], b: number[]) => {
	for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
	return false;
};

/**
 * Pure: helper guardrails. Returns why the call is forbidden, or undefined.
 * Forbidden: --passWithNoTests, new `as unknown as`, package version downgrades (package.json or `npm i x@ver`),
 * skipping / deleting / removing tests.
 */
export function guardCheck(c: Call, readFile: (p: string) => string | undefined = () => undefined): string | undefined {
	if (c.name === "bash" && typeof c.args.command === "string") {
		const cmd = c.args.command;
		if (/--passWithNoTests\b/.test(cmd)) return "uses --passWithNoTests";
		for (const seg of executedSegments(cmd)) {
			if (/^(?:git\s+)?rm\b/.test(seg) && /\.(test|spec)\.|__tests__|\btests?\//.test(seg)) return "deletes test files";
			if (/^(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b.*\s@?[\w./-]+@\d/.test(seg)) return "pins/downgrades package versions";
		}
		if (/\b(?:sed|perl)\b[^\n]*(?:\.skip|as unknown as)/.test(cmd)) return "edits tests/types via sed";
		return undefined;
	}
	if (c.name !== "edit" && c.name !== "write") return undefined;
	const path = editPath(c);
	const pairs = editPairs(c);
	const existing = c.name === "write" ? readFile(path) : undefined;
	for (const { oldText, newText } of pairs) {
		const old = c.name === "write" ? (existing ?? "") : oldText;
		if (count(newText, /\bas unknown as\b/g) > count(old, /\bas unknown as\b/g)) return "adds an `as unknown as` cast";
		if (TEST_FILE.test(path)) {
			if (count(newText, SKIP) > count(old, SKIP)) return "skips tests (.skip/.todo/x*/.only)";
			if (count(newText, TEST_CASE) < count(old, TEST_CASE)) return "removes test cases";
		}
		if (/(^|\/)package\.json$/.test(path)) {
			const before = versions(old);
			for (const [name, v] of versions(newText)) {
				const b = before.get(name);
				if (b && lower(v, b)) return `downgrades ${name} ${b.join(".")} → ${v.join(".")}`;
			}
		}
	}
	return undefined;
}

/** Pure: the tool_call gate. */
export function gateCall(s: SwitchState, c: Call, fileExists: (p: string) => boolean, readFile?: (p: string) => string | undefined): { block: true; reason: string } | undefined {
	if (!isHelper(s.phase)) return undefined;
	if ((BATON_TOOLS as readonly string[]).includes(c.name)) return { block: true, reason: `${c.name} is for the lead model only.` };
	if (s.phase === "read" || s.phase === "followup") {
		if (isReadOnly(c)) return undefined;
		s.wantLead = `helper tried ${c.name} in the reading phase`;
		return { block: true, reason: "Reading phase: only read-only tools. The lead model takes over now; stop and reply READ DONE." };
	}
	// debug / review: no new files
	if (c.name === "write") {
		const p = c.args.path ?? c.args.file_path;
		if (typeof p === "string" && !fileExists(p)) {
			s.wantLead = `helper tried to create ${p}`;
			return { block: true, reason: "Creating new files is the lead model's job. Reply ESCALATE <why>." };
		}
	}
	const why = guardCheck(c, readFile);
	if (why) {
		const f: Flag = { phase: s.phase, tool: c.name, path: editPath(c) || undefined, why, blocked: true };
		s.flags.push(f);
		s.stretchFlags.push(f);
		s.metrics.guardBlocks++;
		// a second guardrail hit in one stretch → the lead decides
		if (s.stretchFlags.length >= 2) s.wantLead = `helper guardrails hit twice (${s.stretchFlags.map((x) => x.why).join("; ")})`;
		return { block: true, reason: `Baton guardrail: the helper may not do this (${why}). Fix the real cause with a proper change, or reply ESCALATE <one line why>.` };
	}
	return undefined;
}

const tail = (t: string, n: number) => (t.length > n ? `…${t.slice(-n)}` : t);
const oneLine = (t: string, n = 140) => t.replace(/\s+/g, " ").trim().slice(0, n);

/**
 * Pure: the honest harness report for a helper → lead handoff. The helper's raw turns never reach the lead; instead
 * this text is attached to the lead's next instruction (a user-role message), so the lead knows exactly that
 * automation — not it — performed these steps.
 */
export function harnessReport(s: SwitchState, from: Phase, why: string, cfg: SwitchConfig, diffStat?: string): string {
	if (from === "read" || from === "followup") {
		if (!s.stretchOutputs.length) return `[Baton harness] Reading was intercepted and performed by automation (helper model); it read nothing useful. (${why})`;
		let budget = cfg.reportChars;
		const parts: string[] = [];
		for (const o of s.stretchOutputs) {
			const body = o.text.length > cfg.clipChars ? `${o.text.slice(0, Math.floor(cfg.clipChars * 0.75))}\n[… ${o.text.length - cfg.clipChars} chars clipped — re-read with offset/limit]\n${o.text.slice(-Math.floor(cfg.clipChars * 0.25))}` : o.text;
			if (budget - body.length < 0) {
				parts.push(`--- ${o.label} ---\n[omitted: report size cap — read it yourself if needed]`);
				continue;
			}
			budget -= body.length;
			parts.push(`--- ${o.label} ---\n${body}`);
		}
		return `[Baton harness] Reading was intercepted and performed by automation (helper model), not by you. Its read-only tool outputs follow (${s.stretchOutputs.length}):\n${parts.join("\n")}`;
	}
	const checks = Object.entries(s.stretchChecks)
		.map(([k, v]) => `$ ${oneLine(v!.cmd, 160)}  → ${k}: ${v!.ok ? "PASS" : "FAIL"}\n${tail(v!.tail, 1200)}`)
		.join("\n");
	const edits = s.stretchEdits.map((e) => `- ${e.path}: ${e.intent}`).join("\n");
	const flags = s.stretchFlags.map((f) => `- ${f.blocked ? "BLOCKED" : "FLAG"} ${f.tool}${f.path ? ` ${f.path}` : ""}: ${f.why}`).join("\n");
	return [
		`[Baton harness] Execution of the following steps was intercepted and performed by automation (helper model), not by you: ${from === "debug" ? "running checks and fixing failures" : "final review"}. Handback reason: ${why}.`,
		`Result: ${s.lastVerifyGreen ? "checks green" : "checks NOT green"}; helper edits: ${s.stretchEdits.length}.`,
		`Final diff summary (git diff --stat):\n${diffStat?.trim() || "(unavailable)"}`,
		`Final check outputs:\n${checks || "(the helper ran no checks)"}`,
		`Helper edits (one line each):\n${edits || "(none)"}`,
		`SUSPICIOUS EDITS (guardrail flags):\n${flags || "(none)"}`,
		`Helper's last note: ${oneLine(s.lastHelperText, 600) || "(none)"}`,
	].join("\n\n");
}

function to(s: SwitchState, inp: TurnInput, next: Phase, reason: string, cfg: SwitchConfig): Decision {
	const from = s.phase;
	let compacted: Decision["compacted"];
	let report = "";
	if (isHelper(from) && !isHelper(next)) {
		compacted = compactAtHandoff(s, from, cfg);
		report = harnessReport(s, from, reason, cfg, from === "debug" || from === "review" ? inp.diffStat?.() : undefined);
		if (from === "debug" || from === "review") s.reverifyOpen = true;
	}
	const reportInfo = report ? { chars: report.length, edits: s.stretchEdits.length, flags: s.stretchFlags.length, outputs: s.stretchOutputs.length } : undefined;
	s.switches.push({ turn: inp.turn, from, to: next, reason, ts: inp.now });
	s.phase = next;
	s.stretchStart = inp.now;
	s.stretchCalls = 0;
	s.leadEditsInStretch = 0;
	s.helperEditsInStretch = 0;
	s.stretchVerifies = [];
	s.stretchReads = [];
	s.stretchOutputs = [];
	s.stretchEdits = [];
	s.stretchChecks = {};
	s.stretchFlags = [];
	s.lastHelperText = "";
	s.wantLead = undefined;
	s.editedSinceVerify = false;
	if (next === "debug") s.red = { sig: "", same: 0, total: 0 };
	if (next === "lead" && (from === "read" || from === "followup")) s.planningLeft = Math.max(s.planningLeft, cfg.planningTurns);
	let message: Decision["message"];
	if (next === "lead") message = { audience: "lead", text: MSG.lead(reason, report) };
	if (next === "debug") message = { audience: "helper", text: MSG.debug };
	if (next === "review") message = { audience: "helper", text: MSG.review };
	if (next === "final") message = { audience: "lead", text: MSG.final(report || `[Baton harness] Review notes: ${inp.text.slice(0, 1500)}`) };
	return { to: next, reason, message, compacted, report: reportInfo, continue: inp.calls.length === 0 && next !== "done" };
}

/** Pure: the switch decision at a turn boundary. Mutates `s` (callers own it). */
export function decideTurn(s: SwitchState, inp: TurnInput, cfg: SwitchConfig = DEFAULT_SWITCH): Decision {
	const resById = new Map(inp.results.map((r) => [r.id, r]));
	const blocked = new Set(s.blocked);
	const real = inp.calls.filter((c) => !blocked.has(c.id));
	const helper = isHelper(s.phase);
	for (const c of real) {
		const p = readPath(c);
		if (p) {
			s.reads.push([c.id, p]);
			if (helper) s.stretchReads.push(c.id);
		}
	}
	s.stretchCalls += real.length;
	const elapsed = inp.now - s.stretchStart;
	const text = inp.text.trim();

	// empty 200 from the lead: retry
	if (!helper && inp.empty) {
		if (s.emptyStreak < cfg.emptyRetries) {
			s.emptyStreak++;
			return { to: s.phase, reason: `empty response retry ${s.emptyStreak}`, continue: true };
		}
		return { to: s.phase, reason: "empty responses exhausted" };
	}
	s.emptyStreak = 0;

	// lead metrics: self-initiated baton calls, re-verification of helper work
	if (!helper) {
		for (const c of real) {
			if ((BATON_TOOLS as readonly string[]).includes(c.name)) {
				s.metrics.selfBaton++;
				s.metrics.selfBatonByTool[c.name] = (s.metrics.selfBatonByTool[c.name] ?? 0) + 1;
			}
		}
		if (s.reverifyOpen) {
			const touched = new Set(s.helperTouched);
			for (const c of real) {
				if (isVerify(c)) s.metrics.reverifyRuns++;
				const p = readPath(c);
				if (p && [...touched].some((t) => t === p || t.endsWith(`/${p}`) || p.endsWith(`/${t}`))) s.metrics.reverifyReads++;
			}
			if (real.some(isEdit)) s.reverifyOpen = false;
		}
	}

	// verify bookkeeping (both models) + honest-handoff material for helper stretches
	if (helper && text) s.lastHelperText = text;
	for (const c of real) {
		const r = resById.get(c.id);
		if (isEdit(c)) {
			s.editedSinceVerify = true;
			if (helper) {
				s.helperEditsInStretch++;
				const path = editPath(c);
				if (path && !s.helperTouched.includes(path)) s.helperTouched.push(path);
				const pairs = editPairs(c);
				const delta = pairs.reduce((a, e) => a + `${e.newText}`.split("\n").length - (e.oldText ? e.oldText.split("\n").length : 0), 0);
				const said = oneLine(text.split("\n").find((l) => l.trim()) ?? "", 140);
				s.stretchEdits.push({ path, intent: `${said || `${c.name} (${pairs.length} replacement(s))`}${r?.isError ? " [edit failed]" : ""} [${delta >= 0 ? "+" : ""}${delta} lines]` });
			} else s.leadEditsInStretch++;
		}
		if (helper && (s.phase === "read" || s.phase === "followup") && isReadOnly(c) && r) {
			const label = readPath(c) ?? (c.name === "bash" ? `$ ${oneLine(String(c.args.command ?? ""), 200)}` : `${c.name} ${oneLine(JSON.stringify(c.args), 200)}`);
			s.stretchOutputs.push({ label, text: r.text });
		}
		const kinds = verifyKinds(c);
		if (kinds.length) {
			if (!helper && kinds.includes("test")) s.leadRanTests = true;
			if (helper) {
				s.stretchVerifies.push(c.id);
				if (r) for (const k of kinds) s.stretchChecks[k] = { cmd: String(c.args.command), ok: !r.isError, tail: r.text };
			}
			if (r?.isError) {
				const sig = failSignature(r.text);
				if (s.editedSinceVerify || s.red.total === 0) {
					s.red.same = sig === s.red.sig ? s.red.same + 1 : 1;
					s.red.total++;
				}
				s.red.sig = sig;
				s.lastVerifyGreen = false;
			} else if (r) {
				s.red = { sig: "", same: 0, total: 0 };
				s.lastVerifyGreen = true;
			}
			s.editedSinceVerify = false;
		}
	}

	switch (s.phase) {
		case "read":
		case "followup": {
			if (s.wantLead) return to(s, inp, "lead", `reading ended: ${s.wantLead}`, cfg);
			if (!real.length) return to(s, inp, "lead", `reading done (${s.reads.length} reads so far)`, cfg);
			if (text.length > cfg.readTextChars) return to(s, inp, "lead", "helper started reasoning — reading done", cfg);
			const cap = s.phase === "read" ? cfg.maxReadCalls : cfg.maxFollowupCalls;
			if (s.stretchCalls >= cap) return to(s, inp, "lead", `reading call cap ${cap} reached`, cfg);
			if (elapsed > cfg.maxHelperMs) return to(s, inp, "lead", `helper stretch > ${Math.round(cfg.maxHelperMs / 1000)} s (cache TTL)`, cfg);
			return { to: s.phase };
		}
		case "debug":
		case "review": {
			if (s.wantLead) return to(s, inp, "lead", `escalated: ${s.wantLead}`, cfg);
			if (s.phase === "debug" && (s.red.same >= cfg.redCycles || s.red.total >= cfg.maxRedTotal)) {
				const why = `escalated after ${s.red.total} red cycles (same failure ×${s.red.same}): ${s.red.sig.slice(0, 200)}`;
				s.planningLeft = cfg.planningTurns;
				return to(s, inp, "lead", why, cfg);
			}
			if (elapsed > cfg.maxHelperMs) return to(s, inp, "lead", `helper stretch > ${Math.round(cfg.maxHelperMs / 1000)} s (cache TTL)`, cfg);
			// no exploratory debugging once everything is green: tsc/build/test all passed in this stretch, nothing red
			if (s.phase === "debug" && real.length && s.lastVerifyGreen && !s.editedSinceVerify) {
				const ch = s.stretchChecks;
				const allGreen = Object.values(ch).every((v) => v!.ok) && !!ch.test && (!!ch.tsc || !!ch.build);
				const exploring = real.some((c) => !isVerify(c) && !isEdit(c) && !isReadOnly(c));
				if (allGreen && exploring) return to(s, inp, "review", "checks green — no exploratory debugging, straight to review", cfg);
			}
			if (real.length) return { to: s.phase };
			if (/ESCALATE/.test(text)) {
				s.planningLeft = cfg.planningTurns;
				return to(s, inp, "lead", `helper escalated: ${text.slice(0, 300)}`, cfg);
			}
			if (s.phase === "review") {
				s.reviewDone = true;
				return cfg.finalCheck ? to(s, inp, "final", "helper review finished", cfg) : to(s, inp, "done", "helper review finished", cfg);
			}
			if (s.leadFinished && s.lastVerifyGreen) {
				s.leadFinished = false;
				return to(s, inp, "review", "verify green after the lead finished", cfg);
			}
			s.leadFinished = false;
			return to(s, inp, "lead", `verify stretch finished (${s.lastVerifyGreen ? "green" : "not green"}, helper edits ${s.helperEditsInStretch}): ${text.slice(0, 300)}`, cfg);
		}
		case "lead": {
			const wrote = real.some(isEdit);
			if (wrote && s.planningLeft > 0) s.planningLeft--;
			s.lastLeadWrote = wrote;
			s.lastLeadLength = !!inp.lengthStop;
			if (inp.lengthStop && !real.length) {
				s.metrics.lengthStops++;
				return { to: s.phase, reason: "lead hit the output cap", message: { audience: "lead", text: MSG.lengthStop }, continue: true };
			}
			const delegate = real.find((c) => c.name === "delegate_reads" || (c.name === "baton_delegate" && c.args.kind !== "debug"));
			if (delegate && s.followups < cfg.maxFollowups) {
				s.followups++;
				const instr = String(delegate.args.instruction ?? "");
				const d = to(s, inp, "followup", `lead delegated reads (round ${s.followups})`, cfg);
				d.message = { audience: "helper", text: MSG.followup(instr) };
				return d;
			}
			const dbg = real.find((c) => c.name === "baton_delegate" && c.args.kind === "debug");
			if (dbg) {
				const d = to(s, inp, "debug", "lead delegated the verify/fix loop", cfg);
				if (dbg.args.instruction) d.message = { audience: "helper", text: `${MSG.debug}\nThe lead model adds: ${String(dbg.args.instruction)}` };
				return d;
			}
			const reads = real.filter((c) => isReadOnly(c));
			if (real.length >= 2 && reads.length === real.length && s.followups < cfg.maxFollowups) {
				s.followups++;
				const d = to(s, inp, "followup", `lead issued only reads (round ${s.followups})`, cfg);
				d.message = { audience: "helper", text: MSG.followup("continue the lead's reads above and anything they obviously lead to") };
				return d;
			}
			const testsReady = s.leadRanTests || !!inp.testsExist;
			if (real.some((c) => isVerify(c)) && s.leadEditsInStretch > 0 && testsReady) return to(s, inp, "debug", "lead ran a verify after writing code (tests exist)", cfg);
			if (!real.length) {
				if (!testsReady && !s.testsNudged && !s.reviewDone && hasLeadCode(s)) {
					s.testsNudged = true;
					return { to: s.phase, reason: "no tests yet — nudged the lead", message: { audience: "lead", text: MSG.noTests }, continue: true };
				}
				if (s.editedSinceVerify && !s.reviewDone) {
					s.leadFinished = true;
					return to(s, inp, "debug", "lead finished writing without a verify run", cfg);
				}
				if (!s.reviewDone) return to(s, inp, "review", "lead finished", cfg);
				return to(s, inp, "done", "lead finished after review", cfg);
			}
			return { to: s.phase };
		}
		case "final": {
			s.lastLeadWrote = real.some(isEdit);
			if (!real.length) {
				s.finalDone = true;
				return to(s, inp, "done", "lead final check finished", cfg);
			}
			return { to: s.phase };
		}
		case "done":
			return { to: "done" };
	}
}

/** The lead has written code at some point (switches into lead with edits recorded via editedSinceVerify / switches). */
function hasLeadCode(s: SwitchState): boolean {
	return s.leadEditsInStretch > 0 || s.switches.some((x) => x.from === "lead" && x.to === "debug");
}

/** Pure: which request shaping a lead request gets. */
export function leadRequestPlan(s: Pick<SwitchState, "phase" | "planningLeft" | "lastLeadWrote" | "lastLeadLength">, cfg: SwitchConfig): { planning: boolean; capReasoning: boolean; maxTokens: number } {
	const planning = s.phase === "lead" && s.planningLeft > 0;
	const expectWrite = s.lastLeadWrote || s.lastLeadLength;
	const capOut = !planning && !expectWrite && cfg.nonWriteMaxTokens > 0 && (s.phase === "final" || s.phase === "lead");
	return { planning, capReasoning: !planning && cfg.thinkingCap > 0, maxTokens: capOut ? Math.min(cfg.leadMaxTokens, Math.max(cfg.nonWriteMaxTokens, cfg.thinkingCap + 2048)) : cfg.leadMaxTokens };
}

/** Pure: estimated spend from per-model cost rows (lead exact, helper × factor). */
export function budgetSpend(rows: Record<string, CostRow>, leadId: string, factor: number): { lead: number; helper: number; estimate: number } {
	let lead = 0;
	let helper = 0;
	for (const r of Object.values(rows)) {
		if (r.model.includes(leadId) || leadId.includes(r.model)) lead += r.cost;
		else helper += r.cost;
	}
	return { lead, helper, estimate: lead + helper * factor };
}

/** Pure: budget stop decision. */
export function budgetExceeded(rows: Record<string, CostRow>, leadId: string, cfg: Pick<SwitchConfig, "budgetUsd" | "helperCostFactor" | "reserveUsd">): { stop: boolean; estimate: number } {
	const { estimate } = budgetSpend(rows, leadId, cfg.helperCostFactor);
	return { stop: cfg.budgetUsd > 0 && estimate + cfg.reserveUsd >= cfg.budgetUsd, estimate };
}

/** Minimal structural message view for context shaping. */
export interface Msg {
	role: string;
	content?: unknown;
	model?: string;
	toolCallId?: string;
	customType?: string;
	[k: string]: unknown;
}

type Block = { type: string; id?: string; text?: string; thinking?: string; [k: string]: unknown };

function isEmptyAssistant(m: Msg): boolean {
	if (m.role !== "assistant") return false;
	const c = (Array.isArray(m.content) ? m.content : []) as Block[];
	return !c.some((b) => b.type === "toolCall" || (b.type === "text" && b.text?.trim()) || (b.type === "thinking" && (b.thinking?.trim() || b.thinkingSignature)) || b.type === "redactedThinking");
}

/**
 * Pure: shape the outgoing request.
 * - always: apply frozen compaction stubs/clips; drop empty assistant messages (failed 200s).
 * - for the lead: helper assistant messages and their tool results are dropped entirely (honest handoff: the
 *   lead's instruction carries a [Baton harness] report instead); blocked calls and helper instructions vanish.
 */
export function shapeContext<T extends Msg>(messages: readonly T[], s: Pick<SwitchState, "stubs" | "clips" | "blocked">, forLead: boolean, leadModelId: string): T[] {
	const blocked = new Set(s.blocked);
	const dropped = new Set<string>();
	const out: T[] = [];
	for (const m of messages) {
		if (isEmptyAssistant(m)) continue;
		if (forLead && m.role === "custom" && m.customType === "baton-switch-helper") continue;
		// honest handoff: helper turns never reach the lead (neither raw nor disguised as the lead's own calls);
		// the lead gets a "[Baton harness]" report inside its next instruction instead.
		if (forLead && m.role === "assistant" && m.model && m.model !== leadModelId) {
			for (const b of (Array.isArray(m.content) ? m.content : []) as Block[]) if (b.type === "toolCall" && b.id) dropped.add(b.id);
			continue;
		}
		if (m.role === "toolResult" && m.toolCallId) {
			if (forLead && (dropped.has(m.toolCallId) || blocked.has(m.toolCallId))) continue;
			const st = s.stubs[m.toolCallId];
			const clip = s.clips[m.toolCallId];
			if (st) {
				out.push({ ...m, content: [{ type: "text", text: st }] });
				continue;
			}
			if (clip !== undefined) {
				const blocks = ((Array.isArray(m.content) ? m.content : []) as Block[]).map((b) =>
					b.type === "text" && b.text && b.text.length > clip
						? { ...b, text: `${b.text.slice(0, Math.floor(clip * 0.75))}\n[baton switch: ${b.text.length - clip} chars clipped at handoff — re-read with offset/limit]\n${b.text.slice(-Math.floor(clip * 0.25))}` }
						: b,
				);
				out.push({ ...m, content: blocks });
				continue;
			}
		}
		out.push(m);
	}
	return out;
}

/** Pure: cap lead reasoning in an OpenRouter chat/completions payload (outside planning). */
export function capReasoning(payload: unknown, cap: number): unknown {
	if (!cap || !payload || typeof payload !== "object") return payload;
	const p = payload as Record<string, unknown>;
	const next: Record<string, unknown> = { ...p, reasoning: { max_tokens: cap } };
	delete next.reasoning_effort;
	return next;
}

export interface CostRow {
	model: string;
	turns: number;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Pure: accumulate per-model usage. */
export function addCost(rows: Record<string, CostRow>, model: string, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined): Record<string, CostRow> {
	const r = rows[model] ?? { model, turns: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		...rows,
		[model]: {
			model,
			turns: r.turns + 1,
			cost: r.cost + (u?.cost?.total ?? 0),
			input: r.input + (u?.input ?? 0),
			output: r.output + (u?.output ?? 0),
			cacheRead: r.cacheRead + (u?.cacheRead ?? 0),
			cacheWrite: r.cacheWrite + (u?.cacheWrite ?? 0),
		},
	};
}

/** Pure: cap max output tokens in a chat/completions payload. */
export function capMaxTokens(payload: unknown, cap: number): unknown {
	if (!cap || !payload || typeof payload !== "object") return payload;
	const p = { ...(payload as Record<string, unknown>) };
	for (const k of ["max_tokens", "max_completion_tokens"]) if (typeof p[k] === "number" && (p[k] as number) > cap) p[k] = cap;
	if (p.max_tokens === undefined && p.max_completion_tokens === undefined) p.max_tokens = cap;
	return p;
}

/** Pure: number of cache_control markers anywhere in a payload. */
export function countCacheControl(x: unknown): number {
	if (Array.isArray(x)) return x.reduce((a: number, v) => a + countCacheControl(v), 0);
	if (!x || typeof x !== "object") return 0;
	let n = 0;
	for (const [k, v] of Object.entries(x)) n += k === "cache_control" && v ? 1 : countCacheControl(v);
	return n;
}

export interface AnchorResult {
	payload: unknown;
	anchored: boolean;
	/** message index that got the breakpoint */
	at?: number;
	partType?: string;
	before: number;
	after: number;
	skipped?: string;
}

const NO_CACHE_PART = new Set(["thinking", "redacted_thinking", "reasoning"]);

/**
 * Pure: add an Anthropic cache breakpoint at the end of the prefix the lead saw in its previous request.
 * pi marks system, last tool and the last message; after a long helper stretch the new last message is more
 * than ~20 blocks past the previous breakpoint, so Anthropic's automatic lookback misses the cached prefix
 * (observed in arm D: one lead turn re-wrote 82k tokens). Guard: never more than 4 breakpoints in total.
 * The marker goes on the last content part of any type (text, image, tool result text …), not only text.
 */
export function anchorCache(payload: unknown, prevLen: number): AnchorResult {
	const before = countCacheControl(payload);
	const no = (skipped: string): AnchorResult => ({ payload, anchored: false, before, after: before, skipped });
	if (!payload || typeof payload !== "object" || prevLen <= 1) return no("no previous prefix");
	if (before >= 4) return no("already 4 breakpoints");
	const p = payload as { messages?: { role: string; content?: unknown }[] };
	if (!Array.isArray(p.messages) || p.messages.length <= prevLen) return no("no growth");
	const messages = p.messages.map((m) => ({ ...m }));
	for (let i = prevLen - 1; i > 0 && i >= prevLen - 4; i--) {
		const m = messages[i]!;
		if (m.role === "system") break;
		if (typeof m.content === "string" && m.content.length) {
			m.content = [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }];
			const out = { ...p, messages };
			return { payload: out, anchored: true, at: i, partType: "text(string)", before, after: countCacheControl(out) };
		}
		if (Array.isArray(m.content) && m.content.length) {
			const parts = m.content.map((x) => ({ ...(x as object) })) as { type?: string; cache_control?: unknown }[];
			for (let j = parts.length - 1; j >= 0; j--) {
				if (NO_CACHE_PART.has(String(parts[j]!.type))) continue;
				if (parts[j]!.cache_control) return no("prefix end already marked");
				parts[j]!.cache_control = { type: "ephemeral" };
				m.content = parts;
				const out = { ...p, messages };
				return { payload: out, anchored: true, at: i, partType: String(parts[j]!.type), before, after: countCacheControl(out) };
			}
		}
	}
	return no("no cacheable part near the previous prefix end");
}
