/**
 * Baton "switch" mode — pure core. One pi session, the lead model (Opus) owns planning and code; a cheap helper
 * model (GLM) runs the reading, verify/debug and final-review stretches. All decisions here are deterministic and
 * side-effect free; src/pi/switch.ts wires them to pi events (tool_call gate, turn_end switch, context shaping).
 */

import { DEFAULT_JEV, initialTrack, type JevConfig, type JevTrack, type TurnJev } from "./jev-config.ts";

export type Phase = "read" | "lead" | "followup" | "implement" | "debug" | "review" | "final" | "done";
export const HELPER_PHASES: readonly Phase[] = ["read", "followup", "implement", "debug", "review"];
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
	/** Cap for an implement stretch (ms). 0 = no limit (default since 0.10.2); the lead cache is kept warm by keepalive. */
	maxImplementMs: number;
	/** Replay the lead payload (max_tokens 1) when the lead was idle this long during a helper stretch (ms, 0 = off). */
	cacheKeepaliveMs: number;
	/** Budget estimate per keepalive (USD; the aborted stream reports no usage). */
	cacheKeepaliveCostUsd: number;
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
	/** 0.9.3 endgame: when budget left (budget − reserve − estimate) < this, the lead keeps working — no mid-work hand-offs to the helper. */
	endgameUsd: number;
	/** 0.10: minimum helper calls before a reading stretch may end (initial read / follow-up); one "read more" nudge. */
	minReadCalls: number;
	minFollowupCalls: number;
	/** 0.10: consecutive read-only lead turns before the helper takes over the reading (was 2). */
	leadReadTurnsToDelegate: number;
	/** 0.10: max chars of the full diff in a helper → lead report after implement/debug (for the lead's review). */
	reviewDiffChars: number;
	/** 0.9: Jev decision model gate (src/pi/jev-policy.ts). */
	jev: JevConfig;
}

export const DEFAULT_SWITCH: SwitchConfig = {
	lead: "openrouter/anthropic/claude-opus-5.5",
	helper: "openrouter/z-ai/glm-5.3-flash",
	maxFollowups: 4,
	redCycles: 6,
	maxRedTotal: 12,
	maxHelperMs: 270_000,
	maxImplementMs: 0,
	cacheKeepaliveMs: 230_000,
	cacheKeepaliveCostUsd: 0.06,
	maxReadCalls: 30,
	maxFollowupCalls: 12,
	readTextChars: 300,
	thinkingCap: 1024,
	planningTurns: 1,
	finalCheck: true,
	emptyRetries: 3,
	clipChars: 50_000,
	leadMaxTokens: 16_000,
	nonWriteMaxTokens: 6_000,
	budgetUsd: 0,
	helperCostFactor: 2.3,
	reserveUsd: 0.25,
	reportChars: 250_000,
	endgameUsd: 0.3,
	minReadCalls: 6,
	minFollowupCalls: 3,
	leadReadTurnsToDelegate: 1,
	reviewDiffChars: 0,
	jev: DEFAULT_JEV,
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
const READ_CMD = /^(ls|cat|head|tail|wc|tree|find|grep|rg|fd|file|stat|pwd|echo|nl|less|more|sort|uniq|cut|awk|jq|du|sed\s+-n|git\s+(-C\s+\S+\s+)?(status|log|diff|show|ls-files|branch|rev-parse)|npm\s+(ls|view|info)|(node|npm|npx|pnpm|yarn|bun|git|tsc)\s+(-v|--version)|which|npx\s+tsc\s+--version)\b/;

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

/** Pure: files a bash call writes (redirects / tee in executed segments, heredoc bodies ignored). */
export function bashWriteTargets(c: Pick<Call, "name" | "args">): string[] {
	if (c.name !== "bash" || typeof c.args.command !== "string") return [];
	const out: string[] = [];
	for (const seg of executedSegments(c.args.command)) {
		for (const m of seg.matchAll(/(?:^|[^0-9&>])>{1,2}\s*([^\s&>]+)/g)) if (!/^\/dev\/(null|std)/.test(m[1]!)) out.push(m[1]!);
		const tee = /^tee\s+(?:-a\s+)?(\S+)/.exec(seg);
		if (tee) out.push(tee[1]!);
	}
	if (!out.length && /\bnode\s+-e\b/.test(c.args.command) && /writeFileSync|writeFile\(/.test(c.args.command)) out.push("(node -e script)");
	return out.map((x) => x.replace(/^\.\//, ""));
}
/** Pure: a code-writing call — edit/write, or bash writing files (arm E: Opus wrote every file via `cat > f <<'EOF'`). */
export const isEdit = (c: Call) => c.name === "edit" || c.name === "write" || bashWriteTargets(c).length > 0;

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
	/** Calls removed from every view (helper changes reverted by the fs guard in a reading phase). */
	dropped: string[];
	/** Bash calls whose fs-guard snapshot showed no change (read-like). */
	noChange: string[];
	/** Consecutive lead turns with only read-like calls. */
	leadReadTurns: number;
	/** fs-guard notes of the current helper stretch (reverted / not reverted changes, installs). */
	stretchGuard: string[];
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
	/** 0.10: "read more" nudge sent in this reading stretch. */
	readNudged: boolean;
	/** 0.10: implement stretches delegated by the lead. */
	implements: number;
	/** 0.9: Jev rolling summary inputs (ring buffer of recent calls, counters, helper-written note). */
	track: JevTrack;
	jev: JevStats;
}

export interface JevStats {
	/** Successful decisions (incl. cache hits). */
	calls: number;
	gateCalls: number;
	turnCalls: number;
	/** Decisions answered by the fallback decision model. */
	fallbackModel: number;
	/** Errors / timeouts / invalid answers → 0.8.1 rules. */
	fallbacks: number;
	cached: number;
	blocks: number;
	handoffs: number;
	switches: number;
	cost: number;
	latMs: number;
	maxLatMs: number;
	summaryCalls: number;
	summaryCost: number;
}
export const initialJevStats = (): JevStats => ({ calls: 0, gateCalls: 0, turnCalls: 0, fallbackModel: 0, fallbacks: 0, cached: 0, blocks: 0, handoffs: 0, switches: 0, cost: 0, latMs: 0, maxLatMs: 0, summaryCalls: 0, summaryCost: 0 });

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
		dropped: [],
		noChange: [],
		leadReadTurns: 0,
		stretchGuard: [],
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
		readNudged: false,
		implements: 0,
		track: initialTrack(),
		jev: initialJevStats(),
	};
}

export const BATON_TOOLS = ["delegate_reads", "baton_delegate", "baton_optimize"] as const;

/** Short, neutral description of the harness tools for the lead's system prompt (no instruction to use them). */
export const LEAD_SYSTEM_NOTE = `

# Baton harness
This session runs under Baton: a cheaper helper model may perform some steps (reading, running checks and small fixes, final review); you will then see an honest "[Baton harness]" report of what it did. Available harness tools: baton_delegate({kind:"reads"|"implement"|"debug", instruction}) hands file reading, the implementation of a precise spec (it may create and edit files), or the verify/fix loop, to the helper; baton_optimize({}) drops superseded read outputs from your context (one cache rewrite). delegate_reads({instruction}) = baton_delegate kind "reads".`;

export const MSG = {
	read: "[baton switch → helper: reading] You are the reader for the lead model, which will plan and write the code for the user's task above. Read, in full, everything it needs: the repository layout and package.json, EVERY SKILL.md and REFERENCE.md of the project skills (.agents/skills, .pi/skills, .claude/skills — read whole files, use offset/limit for long ones until the end), and any docs/examples of the APIs the task uses. Prefer the skills over node_modules sources: they match the installed versions. Your tool outputs are handed to the lead verbatim, so read the actual text — do not summarise. Use read/ls/grep/find/cat; any change to project files is detected and reverted. Do NOT write code, edit files or explain. Make at least 6 tool calls; when everything relevant is read, reply only: READ DONE.",
	followup: (instr: string) =>
		`[baton switch → helper: follow-up reads] The lead model needs more information: ${instr}\nRead the relevant files in full (skills/REFERENCE.md and project files first; node_modules only if the skills do not cover it). Your outputs reach the lead verbatim. Read-only tools only, no explanations; make at least 3 relevant calls, then reply only: READ DONE.`,
	readMore: (n: number, min: number) => `[baton switch → helper] You made only ${n} tool call(s); at least ${min} are expected. Read the remaining relevant skill/reference sections and project files the lead will need (whole files), then reply READ DONE.`,
	implement: (spec: string) =>
		`[baton switch → helper: implement] The lead model has planned the work and hands you its implementation. Spec from the lead:\n${spec}\n\nImplement it exactly: create and edit the files named in the spec (write/edit tools), follow the interfaces and names the lead defined, use the APIs as documented in the project skills. Before each file write ONE short line saying what it contains. Forbidden: --passWithNoTests, \`as unknown as\`, downgrading packages, skipping/deleting/weakening tests, changing files the spec does not mention. Do not redesign. If the spec is ambiguous or needs a design decision, reply only: ESCALATE <one line why>. When all files are written, reply only: IMPLEMENTED (checks run automatically).`,
	debug:
		"[baton switch → helper: verify/debug] Run the project's checks (typecheck, tests, build) and fix failures with small, targeted edits to existing files. Do not create new files, do not redesign, do not write long explanations. Forbidden: --passWithNoTests, `as unknown as` casts, downgrading package versions, skipping/deleting/weakening tests. Before each edit write ONE short line saying what the edit does. When typecheck, tests and build are green, stop immediately (no exploratory or fuzz scripts) and reply only: GREEN. If a fix needs new files, a design change or a forbidden step, reply only: ESCALATE <one line why>.",
	review:
		"[baton switch → helper: final review] Review the whole change (git status, git diff, run typecheck/tests/build once) against the user's task. Fix only clear, small bugs (same restrictions as before: no skipped tests, no `as unknown as`, no version downgrades). Then reply with a short list of remaining issues (or NONE).",
	lead: (why: string, report: string) =>
		`${report ? `${report}\n\n` : ""}[baton switch → lead] ${why}\nYou lead and own the design, but the budget is tight: the helper must do the bulk of the typing. Split: write the plan, the module boundaries and the key types/interfaces (and tricky core logic) yourself, then hand the routine implementation of the remaining files (UI components, wiring, boilerplate, test files from your test list) to the helper with baton_delegate({kind:"implement", instruction:<precise spec: files, exports, signatures, behaviour, tests to write>}); checks run automatically afterwards and you review the diff in the harness report. Need more API details? baton_delegate({kind:"reads", instruction}) — the helper reads skills/docs and hands you the text verbatim.`,
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
	/** 0.9: Jev answers for this turn boundary (absent → 0.8.1 rules only). */
	jev?: TurnJev;
	/** 0.9.3: USD left before the budget stop (undefined = no budget). */
	budgetLeft?: number;
	/** 0.10: full uncommitted diff incl. new files (lazy; for the lead's review after implement/debug). */
	diffFull?: () => string;
	/** 0.10: run the project's checks (typecheck + tests) now (lazy; Baton runs them itself after an implement stretch). */
	autoCheck?: () => { ok: boolean; text: string } | undefined;
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
	if (c.name === "bash") return bashWriteTargets(c).join(", ");
	const p = c.args.path ?? c.args.file_path;
	return typeof p === "string" ? p.replace(/^\.\//, "") : "";
};
const editPairs = (c: Call): { oldText: string; newText: string }[] => {
	if (c.name === "write") return [{ oldText: "", newText: String(c.args.content ?? "") }];
	if (c.name === "bash") return [];
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

/** Pure: the deterministic tool_call gate (0.8.1 rules; always runs first, independent of Jev). */
export const gateCall = (...a: Parameters<typeof gateCallRules>) => gateCallRules(...a);

/**
 * Pure: apply a Jev gate decision to a helper call that passed the deterministic rules. `block` → blocked and the
 * lead takes over after this turn; `allow_handoff` → the call runs, the lead takes over after this turn.
 */
export function applyJevGate(s: SwitchState, c: Call, d: { action: "allow" | "allow_handoff" | "block"; reason: string }): { block: true; reason: string } | undefined {
	if (!isHelper(s.phase) || d.action === "allow") return undefined;
	// implement: creating the files of the lead's spec is the job, so P(allow_handoff) alone does not end the stretch
	if (s.phase === "implement" && d.action === "allow_handoff" && /P\(allow_handoff\)/.test(d.reason)) return undefined;
	if (d.action === "block") {
		const f: Flag = { phase: s.phase, tool: c.name, path: editPath(c) || undefined, why: d.reason, blocked: true };
		s.flags.push(f);
		s.stretchFlags.push(f);
		s.jev.blocks++;
		s.wantLead = `call blocked (${d.reason})`;
		return { block: true, reason: `Baton supervisor: this call was blocked (${d.reason}): it looks like weakening checks or tampering with the environment. The lead model takes over now; reply ESCALATE <one line why>.` };
	}
	s.jev.handoffs++;
	if (/lead should review/.test(d.reason)) {
		const f: Flag = { phase: s.phase, tool: c.name, path: editPath(c) || undefined, why: d.reason, blocked: false };
		s.flags.push(f);
		s.stretchFlags.push(f);
	}
	s.wantLead ??= d.reason;
	return undefined;
}

/** Pure: the tool_call gate — deterministic rules only. */
export function gateCallRules(s: SwitchState, c: Call, fileExists: (p: string) => boolean, readFile?: (p: string) => string | undefined): { block: true; reason: string } | undefined {
	if (!isHelper(s.phase)) return undefined;
	if ((BATON_TOOLS as readonly string[]).includes(c.name)) return { block: true, reason: `${c.name} is for the lead model only.` };
	// reading phases: any tool is allowed; the fs guard (src/pi/fsguard.ts) reverts file changes and hands over
	if (s.phase === "read" || s.phase === "followup") return undefined;
	// debug / review: no new files (implement: the lead's spec names new files)
	if (c.name === "write" && s.phase !== "implement") {
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
export function harnessReport(s: SwitchState, from: Phase, why: string, cfg: SwitchConfig, diffStat?: string, diffFull?: string): string {
	if (from === "read" || from === "followup") {
		if (!s.stretchOutputs.length) return `[Baton harness] Reading was intercepted and performed by automation (helper model); it read nothing useful. (${why})${guardNotes(s)}`;
		let budget = cfg.reportChars;
		const parts: string[] = [];
		// skill files go to the lead verbatim (never clipped, never omitted), once per file — the longest read wins
		// (a later partial read with offset/limit must not replace a full one; ties → the latest)
		const lastSkill = new Map<string, number>();
		s.stretchOutputs.forEach((o, i) => {
			const k = skillKey(o.label);
			if (!k) return;
			const prev = lastSkill.get(k);
			if (prev === undefined || o.text.length >= s.stretchOutputs[prev]!.text.length) lastSkill.set(k, i);
		});
		for (const [i, o] of s.stretchOutputs.entries()) {
			const k = skillKey(o.label);
			if (k) {
				if (lastSkill.get(k) !== i) continue;
				budget -= o.text.length;
				parts.push(`--- ${o.label} (skill file, verbatim) ---\n${o.text}`);
				continue;
			}
			const body = o.text.length > cfg.clipChars ? `${o.text.slice(0, Math.floor(cfg.clipChars * 0.75))}\n[… ${o.text.length - cfg.clipChars} chars clipped — re-read with offset/limit]\n${o.text.slice(-Math.floor(cfg.clipChars * 0.25))}` : o.text;
			if (budget - body.length < 0) {
				parts.push(`--- ${o.label} ---\n[omitted: report size cap — read it yourself if needed]`);
				continue;
			}
			budget -= body.length;
			parts.push(`--- ${o.label} ---\n${body}`);
		}
		return `[Baton harness] Reading was intercepted and performed by automation (helper model), not by you. Its tool outputs follow (${s.stretchOutputs.length}):\n${parts.join("\n")}${guardNotes(s)}`;
	}
	if (from === "implement" || from === "debug" || from === "review") return interruptionSummary(s, from, why, diffStat, diffFull, cfg);
	const checks = Object.entries(s.stretchChecks)
		.map(([k, v]) => `$ ${oneLine(v!.cmd, 160)}  → ${k}: ${v!.ok ? "PASS" : "FAIL"}\n${tail(v!.tail, 1200)}`)
		.join("\n");
	const edits = s.stretchEdits.map((e) => `- ${e.path}: ${e.intent}`).join("\n");
	const flags = s.stretchFlags.map((f) => `- ${f.blocked ? "BLOCKED" : "FLAG"} ${f.tool}${f.path ? ` ${f.path}` : ""}: ${f.why}`).join("\n");
	return [
		`[Baton harness] Execution of the following steps was intercepted and performed by automation (helper model), not by you: ${from}. Handback reason: ${why}.`,
		`Result: ${s.lastVerifyGreen ? "checks green" : "checks NOT green"}; helper edits: ${s.stretchEdits.length}.`,
		`Final diff summary (git diff --stat):\n${diffStat?.trim() || "(unavailable)"}`,
		...(diffFull?.trim() ? [`Full diff for your review (helper changes and everything uncommitted${diffFull.length > cfg.reviewDiffChars ? `, first ${cfg.reviewDiffChars} chars` : ""}):\n${diffFull.slice(0, cfg.reviewDiffChars)}`] : []),
		`Final check outputs:\n${checks || "(the helper ran no checks)"}`,
		`Helper edits (one line each):\n${edits || "(none)"}`,
		`SUSPICIOUS EDITS (guardrail flags):\n${flags || "(none)"}`,
		`Helper's last note: ${oneLine(s.lastHelperText, 600) || "(none)"}`,
	].join("\n\n") + guardNotes(s);
}

/**
 * Pure: compact digest of a unified diff — per file: new/modified/deleted, +/− lines, and the top-level names
 * (functions, consts, classes, types, interfaces, components) whose definitions were added or changed.
 */
export function diffDigest(diff: string): { file: string; status: string; add: number; del: number; names: string[] }[] {
	const out: { file: string; status: string; add: number; del: number; names: string[] }[] = [];
	let cur: (typeof out)[number] | undefined;
	const DEF = /^[+-]\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)|class\s+([\w$]+)|type\s+([\w$]+)|interface\s+([\w$]+)|enum\s+([\w$]+))/;
	for (const line of diff.split("\n")) {
		const f = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
		if (f) {
			cur = { file: f[2]!, status: "modified", add: 0, del: 0, names: [] };
			out.push(cur);
			continue;
		}
		if (!cur) continue;
		if (/^new file mode/.test(line)) cur.status = "new";
		else if (/^deleted file mode/.test(line)) cur.status = "deleted";
		else if (/^(\+\+\+|---) /.test(line)) continue;
		else if (line.startsWith("+")) cur.add++;
		else if (line.startsWith("-")) cur.del++;
		const hunk = /^@@ .*@@\s*(?:export\s+)?(?:async\s+)?(?:function\s+([\w$]+)|(?:const|let|class|interface|type)\s+([\w$]+))/.exec(line);
		const m = DEF.exec(line);
		const name = m ? m.slice(1).find(Boolean) : hunk ? hunk.slice(1).find(Boolean) : undefined;
		if (name && !cur.names.includes(name) && cur.names.length < 12) cur.names.push(name);
	}
	return out;
}

/**
 * Pure: the "[Baton harness] interruption summary" for a helper edit stretch (implement / debug / review).
 * The lead never sees the helper's edit calls or reasoning — only what was done, which files and definitions
 * changed, and the check status. Details on request: the lead reads the files or runs `git diff` itself.
 */
export function interruptionSummary(s: SwitchState, from: Phase, why: string, diffStat?: string, diffFull?: string, cfg: SwitchConfig = DEFAULT_SWITCH): string {
	const what = from === "implement" ? "implemented your spec" : from === "debug" ? "ran the checks and fixed failures" : "reviewed the change";
	const helperFiles = new Set(s.stretchEdits.flatMap((e) => e.path.split(", ").filter(Boolean)));
	const digest = diffFull ? diffDigest(diffFull) : [];
	const touched = digest.filter((d) => !helperFiles.size || [...helperFiles].some((h) => h === d.file || h.endsWith(`/${d.file}`) || d.file.endsWith(h.replace(/^.*?\/(?=src\/)/, ""))));
	const files = (touched.length ? touched : digest).map((d) => `- ${d.file} (${d.status}, +${d.add}/−${d.del})${d.names.length ? `: ${d.names.join(", ")}` : ""}`);
	const fallback = s.stretchEdits.map((e) => `- ${e.path}: ${e.intent}`);
	const checks = Object.entries(s.stretchChecks).map(([k, v]) => `- ${k === "tsc" && v!.cmd.startsWith("(baton") ? "auto-check (typecheck + tests)" : k}: ${v!.ok ? "PASS" : "FAIL"}${v!.ok ? "" : ` — ${oneLine(v!.tail.split("\n").filter((l) => /error|fail|✗|×/i.test(l)).slice(0, 3).join(" | "), 300)}`}`);
	const flags = s.stretchFlags.map((f) => `- ${f.blocked ? "BLOCKED" : "FLAG"} ${f.tool}${f.path ? ` ${f.path}` : ""}: ${f.why}`);
	return [
		`[Baton harness] interruption summary — automation (helper model), not you, ${what} while you were paused. Handback reason: ${why}.`,
		`Files and definitions changed by the helper (${s.stretchEdits.length} edit call(s)):\n${(files.length ? files : fallback).join("\n") || "(none)"}`,
		`Checks: ${s.lastVerifyGreen ? "GREEN" : "NOT green"}\n${checks.join("\n") || "- (no checks ran)"}`,
		...(flags.length ? [`SUSPICIOUS EDITS (guardrails):\n${flags.join("\n")}`] : []),
		...(cfg.reviewDiffChars > 0 && diffFull ? [`Diff (first ${cfg.reviewDiffChars} chars):\n${diffFull.slice(0, cfg.reviewDiffChars)}`] : []),
		`Helper's last note: ${oneLine(s.lastHelperText, 300) || "(none)"}`,
		`Details on request: read the files or run \`git diff\` yourself.${diffStat?.trim() ? `\ngit diff --stat:\n${diffStat.trim().split("\n").slice(-25).join("\n")}` : ""}`,
	].join("\n\n") + guardNotes(s);
}

/** Skill documents: SKILL.md / REFERENCE.md anywhere, or any file under a skills directory (.agents/skills, .pi/skills, .claude/skills, skills/). */
export const SKILL_PATH = /(?:^|\/)(?:SKILL|REFERENCE)\.md$|(?:^|\/)(?:\.agents|\.pi|\.claude)\/skills\/|(?:^|\/)skills\/[^\s]+\.md$/;

/** Pure: dedup key of a read output whose label is a skill file (read path or `$ cat <one skill file>`), else undefined. */
export function skillKey(label: string): string | undefined {
	const p = label.startsWith("$ ") ? /^\$ cat\s+(\S+)\s*$/.exec(label)?.[1] : label;
	if (!p) return undefined;
	const norm = p.replace(/^\.\//, "").replace(/^.*?((?:\.agents|\.pi|\.claude)\/skills\/|skills\/)/, "$1");
	return SKILL_PATH.test(p) ? norm : undefined;
}

function guardNotes(s: SwitchState): string {
	return s.stretchGuard.length ? `\n\n[Baton harness] File-system guard during this stretch:\n${s.stretchGuard.map((x) => `- ${x}`).join("\n")}` : "";
}

function to(s: SwitchState, inp: TurnInput, next: Phase, reason: string, cfg: SwitchConfig): Decision {
	const from = s.phase;
	let compacted: Decision["compacted"];
	let report = "";
	if (isHelper(from) && !isHelper(next)) {
		compacted = compactAtHandoff(s, from, cfg);
		const exec = from === "debug" || from === "review" || from === "implement";
		report = harnessReport(s, from, reason, cfg, exec ? inp.diffStat?.() : undefined, exec ? inp.diffFull?.() : undefined);
		if (exec) s.reverifyOpen = true;
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
	s.stretchGuard = [];
	s.leadReadTurns = 0;
	s.lastHelperText = "";
	s.wantLead = undefined;
	s.readNudged = false;
	s.editedSinceVerify = false;
	if (next === "debug") s.red = { sig: "", same: 0, total: 0 };
	if (next === "lead" && (from === "read" || from === "followup")) s.planningLeft = Math.max(s.planningLeft, cfg.planningTurns);
	let message: Decision["message"];
	if (next === "lead") message = { audience: "lead", text: MSG.lead(reason, report) };
	if (next === "debug") message = { audience: "helper", text: MSG.debug };
	if (next === "implement") message = { audience: "helper", text: MSG.implement(inp.text) };
	if (next === "review") message = { audience: "helper", text: MSG.review };
	if (next === "final") message = { audience: "lead", text: MSG.final(report || `[Baton harness] Review notes: ${inp.text.slice(0, 1500)}`) };
	return { to: next, reason, message, compacted, report: reportInfo, continue: inp.calls.length === 0 && next !== "done" };
}

/** Pure: the switch decision at a turn boundary. Mutates `s` (callers own it). */
export function decideTurn(s: SwitchState, inp: TurnInput, cfg: SwitchConfig = DEFAULT_SWITCH): Decision {
	const resById = new Map(inp.results.map((r) => [r.id, r]));
	const blocked = new Set([...s.blocked, ...s.dropped]);
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
		if (helper && (s.phase === "read" || s.phase === "followup") && !isEdit(c) && r) {
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
			const minCalls = s.phase === "read" ? cfg.minReadCalls : cfg.minFollowupCalls;
			if (!real.length && s.stretchCalls < minCalls && !s.readNudged && elapsed < cfg.maxHelperMs) {
				s.readNudged = true;
				return { to: s.phase, reason: `helper read too little (${s.stretchCalls}/${minCalls}) — nudged`, message: { audience: "helper", text: MSG.readMore(s.stretchCalls, minCalls) }, continue: true };
			}
			if (!real.length) return to(s, inp, "lead", `reading done (${s.stretchCalls} helper calls, ${s.reads.length} reads so far)`, cfg);
			if (text.length > cfg.readTextChars) return to(s, inp, "lead", "helper started reasoning — reading done", cfg);
			const cap = s.phase === "read" ? cfg.maxReadCalls : cfg.maxFollowupCalls;
			if (s.stretchCalls >= cap) return to(s, inp, "lead", `reading call cap ${cap} reached`, cfg);
			if (elapsed > cfg.maxHelperMs) return to(s, inp, "lead", `helper stretch > ${Math.round(cfg.maxHelperMs / 1000)} s (cache TTL)`, cfg);
			return { to: s.phase };
		}
		case "implement": {
			if (s.wantLead) return to(s, inp, "lead", `implementation escalated: ${s.wantLead}`, cfg);
			if (cfg.maxImplementMs > 0 && elapsed > cfg.maxImplementMs) return to(s, inp, "lead", `implement stretch > ${Math.round(cfg.maxImplementMs / 1000)} s — partial implementation, see diff`, cfg);
			if (real.length) return { to: s.phase };
			if (/ESCALATE/.test(text)) return to(s, inp, "lead", `helper escalated the implementation: ${text.slice(0, 300)}`, cfg);
			// done: Baton runs the checks itself; red → the helper fixes (debug), green → the lead reviews the diff
			const chk = inp.autoCheck?.();
			if (chk) {
				s.stretchChecks.tsc = { cmd: "(baton auto-check) typecheck + tests", ok: chk.ok, tail: chk.text };
				s.lastVerifyGreen = chk.ok;
				if (!chk.ok) {
					const d = to(s, inp, "debug", "implementation done; baton auto-check is red → helper fixes", cfg);
					d.message = { audience: "helper", text: `${MSG.debug}\nBaton ran the checks after your implementation:\n${chk.text.slice(-3000)}` };
					return d;
				}
			}
			return to(s, inp, "lead", `implementation done${chk ? " — baton auto-check green" : ""}; review the diff`, cfg);
		}
		case "debug":
		case "review": {
			if (s.wantLead) return to(s, inp, "lead", `escalated: ${s.wantLead}`, cfg);
			if (inp.jev && inp.jev.stuck >= cfg.jev.thr.stuck) {
				s.jev.switches++;
				s.planningLeft = cfg.planningTurns;
				return to(s, inp, "lead", `jev: stuck ${inp.jev.stuck.toFixed(2)} (red ×${s.red.same}, total ${s.red.total})`, cfg);
			}
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
			const impl = real.find((c) => c.name === "baton_delegate" && c.args.kind === "implement");
			if (impl) {
				s.implements++;
				const spec = String(impl.args.instruction ?? "") || text;
				const d = to(s, inp, "implement", `lead delegated implementation (#${s.implements})`, cfg);
				d.message = { audience: "helper", text: MSG.implement(spec) };
				return d;
			}
			const delegate = real.find((c) => c.name === "delegate_reads" || (c.name === "baton_delegate" && c.args.kind === "reads"));
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
			// "the lead only reads": two consecutive lead turns whose calls are all read-like
			// (read tools, read-only bash, or bash the fs guard saw change nothing) → the helper reads instead
			const readLike = (c: Call) => !isEdit(c) && !isVerify(c) && !(BATON_TOOLS as readonly string[]).includes(c.name) && (isReadOnly(c) || s.noChange.includes(c.id));
			s.leadReadTurns = real.length && real.every(readLike) ? s.leadReadTurns + 1 : 0;
			const endgame = inp.budgetLeft !== undefined && inp.budgetLeft < cfg.endgameUsd;
			// 0.9: Jev predicts routine (non-write) work ahead after ≥2 consecutive non-write calls → helper reads
			if (!endgame && inp.jev && real.length && !real.some(isEdit) && !(real.some(isVerify) && s.leadEditsInStretch > 0) && inp.jev.routine >= cfg.jev.thr.routine && s.track.leadNonWrite >= cfg.jev.thr.minNonWrite && s.track.routineHandoffs < cfg.jev.maxRoutineHandoffs) {
				s.track.routineHandoffs++;
				s.jev.switches++;
				const d = to(s, inp, "followup", `jev: routine ahead ${inp.jev.routine.toFixed(2)} after ${s.track.leadNonWrite} lead non-write calls`, cfg);
				const last = real.map((c) => (c.name === "bash" ? `$ ${String(c.args.command ?? "").replace(/\s+/g, " ").slice(0, 200)}` : `${c.name} ${JSON.stringify(c.args).slice(0, 200)}`)).join("\n- ");
				d.message = { audience: "helper", text: MSG.followup(`the lead was exploring with these calls:\n- ${last}\nContinue this exploration: read/search the related files, types and docs the lead will need next (at least 3 calls) before replying READ DONE`) };
				return d;
			}
			if (!endgame && s.leadReadTurns >= cfg.leadReadTurnsToDelegate && s.followups < cfg.maxFollowups) {
				s.followups++;
				const d = to(s, inp, "followup", `lead issued only reads (round ${s.followups})`, cfg);
				const last = real.map((c) => (c.name === "bash" ? `$ ${String(c.args.command ?? "").replace(/\s+/g, " ").slice(0, 200)}` : `${c.name} ${JSON.stringify(c.args).slice(0, 200)}`)).join("\n- ");
				d.message = { audience: "helper", text: MSG.followup(`the lead was reading with these calls:\n- ${last}\nFind the same information in the project skills/REFERENCE.md first, then read what these calls lead to`) };
				return d;
			}
			const testsReady = s.leadRanTests || !!inp.testsExist;
			// 0.9.3: only a RED verify hands the fix loop to the helper; a green mid-work verify leaves the lead writing
			// (arm G: green tests → GLM took over before the UI existed, tried to create it, got blocked, 1 min lost)
			const redVerify = real.some((c) => isVerify(c) && resById.get(c.id)?.isError);
			if (!endgame && redVerify && s.leadEditsInStretch > 0 && testsReady) return to(s, inp, "debug", "lead's verify after writing code failed (tests exist)", cfg);
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
export function leadRequestPlan(s: Pick<SwitchState, "phase" | "planningLeft" | "lastLeadWrote" | "lastLeadLength" | "leadReadTurns">, cfg: SwitchConfig): { planning: boolean; capReasoning: boolean; maxTokens: number } {
	// planning (full thinking) is pending until the first write, but read-only turns meanwhile stay capped:
	// after a read-only lead turn the next one is predicted read-only too (arm E: 12 uncapped read turns)
	const planning = s.phase === "lead" && s.planningLeft > 0 && !(s.leadReadTurns > 0);
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
export function shapeContext<T extends Msg>(messages: readonly T[], s: Pick<SwitchState, "stubs" | "clips" | "blocked"> & { dropped?: string[] }, forLead: boolean, leadModelId: string): T[] {
	const blocked = new Set(s.blocked);
	const dropped = new Set<string>(s.dropped ?? []);
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
		if (!forLead && m.role === "assistant" && s.dropped?.length) {
			const all = (Array.isArray(m.content) ? m.content : []) as Block[];
			const kept = all.filter((b) => !(b.type === "toolCall" && b.id && dropped.has(b.id)));
			if (kept.length !== all.length) {
				if (kept.some((b) => b.type === "toolCall" || (b.type === "text" && b.text?.trim()))) out.push({ ...m, content: kept });
				continue;
			}
		}
		if (m.role === "toolResult" && m.toolCallId) {
			if (dropped.has(m.toolCallId) || (forLead && blocked.has(m.toolCallId))) continue;
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
