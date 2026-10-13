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
const READ_CMD = /^(ls|cat|head|tail|wc|tree|find|grep|rg|fd|file|stat|pwd|echo|nl|less|more|sort|uniq|cut|awk|jq|du|sed\s+-n|git\s+(status|log|diff|show|ls-files|branch|rev-parse)|npm\s+(ls|view|info)|node\s+(-v|--version)|npx\s+tsc\s+--version)\b/;

/** Pure: a read-only tool call (read/grep/find/ls, or a bash pipeline of read commands without redirects). */
export function isReadOnly(c: Pick<Call, "name" | "args">): boolean {
	if (READ_TOOLS.has(c.name)) return true;
	if (c.name !== "bash") return false;
	const cmd = typeof c.args.command === "string" ? c.args.command : "";
	if (!cmd.trim() || /(^|[^2&])>|>>|\btee\b|\$\(|`/.test(cmd.replace(/2>&1|2>\/dev\/null|>\s*\/dev\/null/g, ""))) return false;
	const segs = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim().replace(/^cd\s+\S+\s*$/, "pwd")).filter(Boolean);
	return segs.length > 0 && segs.every((s) => READ_CMD.test(s));
}

const VERIFY = /\b(vitest|jest|mocha|tsc|vite\s+build|node\s+--test|(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|check|typecheck|lint)|npx\s+(vitest|tsc|jest|vite\s+build))\b/;
/** Pure: a verify run (tests / typecheck / build). */
export function isVerify(c: Pick<Call, "name" | "args">): boolean {
	return c.name === "bash" && typeof c.args.command === "string" && VERIFY.test(c.args.command);
}

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
	planningLeft: number;
	/** Set by the tool_call gate: the helper tried something outside its phase. */
	wantLead?: string;
	/** Helper calls blocked by the gate (removed from the lead's view). */
	blocked: string[];
	/** Read calls seen: id → normalised path (for dedup at compaction). */
	reads: [string, string][];
	/** Verify calls in the current helper stretch. */
	stretchVerifies: string[];
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
		blocked: [],
		reads: [],
		stretchVerifies: [],
		stubs: {},
		clips: {},
		switches: [],
	};
}

export const MSG = {
	read: "[baton switch → helper: reading] Explore the repository and the project skills with read-only tools (read, ls, grep, find, or read-only bash such as cat/ls/rg/git log). Read everything the lead model will need to plan and write the code. Do NOT write code, edit files or explain at length. When you have read enough, reply only: READ DONE.",
	followup: (instr: string) =>
		`[baton switch → helper: follow-up reads] The lead model asks you to read: ${instr}\nUse read-only tools only, read exactly what is needed, do not explain. Then reply only: READ DONE.`,
	debug:
		"[baton switch → helper: verify/debug] Run the project's checks (typecheck, tests, build) and fix failures with small, targeted edits to existing files. Do not create new files, do not redesign, do not write long explanations. When all checks are green reply only: GREEN. If a fix needs new files or a design change, reply only: ESCALATE <one line why>.",
	review:
		"[baton switch → helper: final review] Review the whole change (git status, git diff, run typecheck/tests/build once) against the user's task. Fix only clear, small bugs. Then reply with a short list of remaining issues (or NONE).",
	lead: (why: string, followupsLeft: number) =>
		`[baton switch → lead] ${why}\nYou lead: plan briefly and write the code (edit/write). A cheaper helper runs verification (tests/typecheck/build) and fix loops after your edits and hands control back to you. To have more files read cheaply, call delegate_reads({instruction}) (${followupsLeft} round(s) left) instead of reading many files yourself.`,
	final: (issues: string) =>
		`[baton switch → lead: final check] The helper finished the final review. Its notes: ${issues.slice(0, 1500) || "(none)"}\nDo a SHORT final check. Fix only real problems; otherwise reply DONE in one line.`,
};

export interface TurnInput {
	turn: number;
	now: number;
	text: string;
	calls: Call[];
	results: Result[];
	empty: boolean;
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
}

function stub(why: string): string {
	return `[baton switch: output compacted at handoff (${why}) — rerun the command or re-read the file if you need it]`;
}

/** Pure: freeze compaction for a helper → lead handoff. Mutates the given (copied) state. */
export function compactAtHandoff(s: SwitchState, from: Phase, cfg: SwitchConfig): { stubbed: number; clipped: number } {
	let stubbed = 0;
	let clipped = 0;
	// duplicate reads of one path: keep the latest
	const last = new Map<string, string>();
	for (const [id, p] of s.reads) last.set(p, id);
	for (const [id, p] of s.reads) {
		if (last.get(p) !== id && !s.stubs[id]) {
			s.stubs[id] = stub(`superseded by a later read of ${p}`);
			stubbed++;
		}
	}
	for (const [id] of s.reads) {
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

/** Pure: the tool_call gate. */
export function gateCall(s: SwitchState, c: Call, fileExists: (p: string) => boolean): { block: true; reason: string } | undefined {
	if (!isHelper(s.phase)) return undefined;
	if (c.name === "delegate_reads") return { block: true, reason: "delegate_reads is for the lead model only." };
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
	return undefined;
}

function to(s: SwitchState, inp: TurnInput, next: Phase, reason: string, cfg: SwitchConfig): Decision {
	const from = s.phase;
	let compacted: Decision["compacted"];
	if (isHelper(from) && !isHelper(next)) compacted = compactAtHandoff(s, from, cfg);
	s.switches.push({ turn: inp.turn, from, to: next, reason, ts: inp.now });
	s.phase = next;
	s.stretchStart = inp.now;
	s.stretchCalls = 0;
	s.leadEditsInStretch = 0;
	s.helperEditsInStretch = 0;
	s.stretchVerifies = [];
	s.wantLead = undefined;
	s.editedSinceVerify = false;
	if (next === "debug") s.red = { sig: "", same: 0, total: 0 };
	if (next === "lead" && from === "read") s.planningLeft = cfg.planningTurns;
	let message: Decision["message"];
	const left = cfg.maxFollowups - s.followups;
	if (next === "lead") message = { audience: "lead", text: MSG.lead(reason, left) };
	if (next === "debug") message = { audience: "helper", text: MSG.debug };
	if (next === "review") message = { audience: "helper", text: MSG.review };
	if (next === "final") message = { audience: "lead", text: MSG.final(inp.text) };
	return { to: next, reason, message, compacted, continue: inp.calls.length === 0 && next !== "done" };
}

/** Pure: the switch decision at a turn boundary. Mutates `s` (callers own it). */
export function decideTurn(s: SwitchState, inp: TurnInput, cfg: SwitchConfig = DEFAULT_SWITCH): Decision {
	const resById = new Map(inp.results.map((r) => [r.id, r]));
	const blocked = new Set(s.blocked);
	const real = inp.calls.filter((c) => !blocked.has(c.id));
	for (const c of real) {
		const p = readPath(c);
		if (p) s.reads.push([c.id, p]);
	}
	s.stretchCalls += real.length;
	const helper = isHelper(s.phase);
	const elapsed = inp.now - s.stretchStart;

	// empty 200 from the lead: retry
	if (!helper && inp.empty) {
		if (s.emptyStreak < cfg.emptyRetries) {
			s.emptyStreak++;
			return { to: s.phase, reason: `empty response retry ${s.emptyStreak}`, continue: true };
		}
		return { to: s.phase, reason: "empty responses exhausted" };
	}
	s.emptyStreak = 0;

	// verify bookkeeping (both models)
	for (const c of real) {
		if (isEdit(c)) {
			s.editedSinceVerify = true;
			if (helper) s.helperEditsInStretch++;
			else s.leadEditsInStretch++;
		}
		if (isVerify(c)) {
			const r = resById.get(c.id);
			if (helper) s.stretchVerifies.push(c.id);
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

	const text = inp.text.trim();
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
			if (s.planningLeft > 0) s.planningLeft--;
			const delegate = real.find((c) => c.name === "delegate_reads");
			if (delegate && s.followups < cfg.maxFollowups) {
				s.followups++;
				const instr = String(delegate.args.instruction ?? "");
				const d = to(s, inp, "followup", `lead delegated reads (round ${s.followups})`, cfg);
				d.message = { audience: "helper", text: MSG.followup(instr) };
				return d;
			}
			const reads = real.filter((c) => isReadOnly(c));
			if (real.length >= 2 && reads.length === real.length && s.followups < cfg.maxFollowups) {
				s.followups++;
				const d = to(s, inp, "followup", `lead issued only reads (round ${s.followups})`, cfg);
				d.message = { audience: "helper", text: MSG.followup("continue the lead's reads above and anything they obviously lead to") };
				return d;
			}
			if (real.some((c) => isVerify(c)) && s.leadEditsInStretch > 0) return to(s, inp, "debug", "lead ran a verify after writing code", cfg);
			if (!real.length) {
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
 * - for the lead: helper assistant messages keep only their (non-blocked) tool calls — no text, no thinking;
 *   blocked calls and their results disappear; helper-directed instructions are dropped.
 */
export function shapeContext<T extends Msg>(messages: readonly T[], s: Pick<SwitchState, "stubs" | "clips" | "blocked">, forLead: boolean, leadModelId: string): T[] {
	const blocked = new Set(s.blocked);
	const dropped = new Set<string>();
	const out: T[] = [];
	for (const m of messages) {
		if (isEmptyAssistant(m)) continue;
		if (forLead && m.role === "custom" && m.customType === "baton-switch-helper") continue;
		if (forLead && m.role === "assistant" && m.model && m.model !== leadModelId) {
			const blocks = ((Array.isArray(m.content) ? m.content : []) as Block[]).filter((b) => {
				if (b.type !== "toolCall") return false;
				if (b.id && blocked.has(b.id)) {
					dropped.add(b.id);
					return false;
				}
				return true;
			});
			if (!blocks.length) continue;
			out.push({ ...m, content: blocks });
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
