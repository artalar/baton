import type { TriggerConfig } from "./config.ts";

export interface TriggerState {
	toolCalls: number;
	/** toolCalls value at the last advisor call. */
	lastAdvisorAt: number;
	/** toolCalls value at the last automatic nudge (cooldown anchor). */
	lastNudgeAt: number;
	errCounts: Record<string, number>;
	/** Signatures already nudged for, so the same signature does not nag every call. */
	nudgedSigs: string[];
	reviewPassed: boolean;
	/** Whether the ctx-ratio nudge already fired since the last reset. */
	ctxNudged: boolean;
	/** Exploration (read-only) calls so far without a plan. */
	readOnlyCalls: number;
	/** A file was written/edited at least once. */
	wroteAny: boolean;
	/** Files were written since the last review. */
	dirtySinceReview: boolean;
	/** An advisor plan exists (baton_plan/help, or a review that returned steps). */
	hasPlan: boolean;
	autoPlanNudged: boolean;
	/** The one-time plan-before-write soft gate already fired. */
	planGateFired: boolean;
	/** Milestone review nudge already sent since the last review. */
	milestoneNudged: boolean;
	/** toolCalls value at the last baton_step (or plan). */
	lastStepAt: number;
	driftNudged: boolean;
	/** A milestone happened since the last nudge evaluation. */
	pendingMilestone?: boolean;
}

/** Facts about one finished tool call used by the planning/milestone triggers. */
export interface CallFacts {
	/** read / ls / grep / find, or a bash command that only inspects. */
	readOnly?: boolean;
	/** Tests passed (no failures) or a build/typecheck exited 0. */
	milestone?: boolean;
}

export function initialTriggerState(): TriggerState {
	return {
		toolCalls: 0,
		lastAdvisorAt: 0,
		lastNudgeAt: -Infinity,
		errCounts: {},
		nudgedSigs: [],
		reviewPassed: false,
		ctxNudged: false,
		readOnlyCalls: 0,
		wroteAny: false,
		dirtySinceReview: false,
		hasPlan: false,
		autoPlanNudged: false,
		planGateFired: false,
		milestoneNudged: false,
		lastStepAt: 0,
		driftNudged: false,
	};
}

export type Nudge =
	| { kind: "context"; ratio: number; message: string }
	| { kind: "same_error"; sig: string; count: number; message: string }
	| { kind: "reminder"; calls: number; message: string }
	| { kind: "auto_plan"; calls: number; message: string }
	| { kind: "milestone"; message: string }
	| { kind: "drift"; calls: number; message: string };

const READ_ONLY_TOOLS = new Set(["read", "ls", "grep", "find", "baton_recall"]);
export const BASH_INSPECT_SEG = /^\s*(ls|cat|head|tail|sed -n|find|grep|rg|tree|wc|pwd|git (status|log|show|diff|ls-files)|npm (ls|view)|node -v)\b/;
const BASH_INSPECT = /^\s*(ls|cat|head|tail|sed -n|find|grep|rg|tree|wc|pwd|git (status|log|show|diff|ls-files)|npm (ls|view)|node -v|npx -y skills list)\b/;
const BUILD_CMD = /\b(tsc|vite build|npm run (build|typecheck|check)|pnpm (build|typecheck)|cargo (build|check)|go build)\b/;

/** Pure: derive CallFacts from a journal-like record. */
export function callFacts(tool: string, command: string | undefined, exit: number | null | undefined, test: { passed: number; failed: number } | null | undefined): CallFacts {
	const readOnly = READ_ONLY_TOOLS.has(tool) || (tool === "bash" && !!command && command.split(/&&|;|\|/).every((seg) => BASH_INSPECT.test(seg)));
	const milestone = (!!test && test.failed === 0 && test.passed > 0 && exit === 0) || (tool === "bash" && !!command && BUILD_CMD.test(command) && exit === 0);
	return { readOnly, milestone };
}

const ADVISOR_TOOLS = new Set(["baton_review", "baton_help", "baton_plan"]);

/** Pure reducer: account for one finished tool call. */
export function onToolResult(s: TriggerState, tool: string, errSig: string | null | undefined, wroteFile: boolean, facts: CallFacts = {}): TriggerState {
	const n: TriggerState = { ...s, errCounts: { ...s.errCounts }, toolCalls: s.toolCalls + 1 };
	if (ADVISOR_TOOLS.has(tool)) n.lastAdvisorAt = n.toolCalls;
	if (tool === "baton_step") {
		n.lastStepAt = n.toolCalls;
		n.driftNudged = false;
	}
	if (errSig) n.errCounts[errSig] = (n.errCounts[errSig] ?? 0) + 1;
	if (wroteFile) {
		n.reviewPassed = false; // new edits invalidate a previous review
		n.wroteAny = true;
		n.dirtySinceReview = true;
	}
	if (facts.readOnly && !n.wroteAny && !n.hasPlan) n.readOnlyCalls++;
	if (facts.milestone && n.dirtySinceReview && !n.milestoneNudged) n.pendingMilestone = true;
	return n;
}

/** Pure: soft gate — block the first write/edit once when no plan exists yet. */
export function planGate(tool: string, s: TriggerState, cfg: TriggerConfig): { block: true; reason: string } | undefined {
	if (!cfg.planBeforeWrite || s.hasPlan || s.planGateFired || (tool !== "write" && tool !== "edit")) return undefined;
	return {
		block: true,
		reason: `Baton: you explored for ${s.readOnlyCalls} calls and are about to write code without a plan. Call baton_plan now (it sees the project skills and your findings) so the architecture follows the project rules. If the task is trivial, simply retry this write; this gate fires only once.`,
	};
}

export function onAdvisor(s: TriggerState, kind: "review" | "help" | "plan", verdict: string, planSteps = 0): TriggerState {
	const n = { ...s, lastAdvisorAt: s.toolCalls };
	if (kind === "review") {
		n.reviewPassed = verdict === "on_track" || verdict === "done";
		n.dirtySinceReview = false;
		n.milestoneNudged = false;
		n.pendingMilestone = false;
	}
	if (kind !== "review" || planSteps > 0) {
		n.hasPlan = true;
		n.lastStepAt = s.toolCalls;
		n.driftNudged = false;
	}
	if (kind !== "review") {
		n.errCounts = {};
		n.nudgedSigs = [];
		n.ctxNudged = false;
	}
	return n;
}

/**
 * Pure: decide which nudge (at most one) to send now. Cooldown: no automatic nudge within
 * `minGapCalls` tool calls of the previous nudge or advisor call. Same-error ignores cooldown
 * only when it reaches the threshold for the first time.
 */
export function evaluate(s: TriggerState, cfg: TriggerConfig, contextRatio: number | null, compact = false): { nudge?: Nudge; state: TriggerState } {
	const sinceAnchor = s.toolCalls - Math.max(s.lastNudgeAt, s.lastAdvisorAt);
	const cooled = sinceAnchor >= cfg.minGapCalls;
	const fire = (nudge: Nudge, patch: Partial<TriggerState>) => ({ nudge, state: { ...s, ...patch, lastNudgeAt: s.toolCalls } });

	if (cfg.sameErrorCount > 0) {
		for (const [sig, count] of Object.entries(s.errCounts)) {
			if (count >= cfg.sameErrorCount && !s.nudgedSigs.includes(sig))
				return fire(
					{ kind: "same_error", sig, count, message: `Baton: the same error appeared ${count}× (${sig}). Stop retrying; call baton_help with your hypothesis and what you tried.` },
					{ nudgedSigs: [...s.nudgedSigs, sig] },
				);
		}
	}
	// First milestone after edits: early review (ignores cooldown, once per review cycle).
	if (cfg.milestoneReview && s.pendingMilestone && !s.milestoneNudged)
		return fire(
			{ kind: "milestone", message: "Baton: milestone reached (tests/build green after your edits). Call baton_review now — an early review is far cheaper than rework later." },
			{ milestoneNudged: true, pendingMilestone: false },
		);
	// Exploration done, still no plan: ask for the plan before code gets written.
	if (cfg.autoPlanAfterReads > 0 && !s.hasPlan && !s.autoPlanNudged && !s.wroteAny && s.readOnlyCalls >= cfg.autoPlanAfterReads)
		return fire(
			{ kind: "auto_plan", calls: s.readOnlyCalls, message: `Baton: ${s.readOnlyCalls} exploration calls done. Call baton_plan now, before writing code; the advisor sees the project skills, the repo map and your findings.` },
			{ autoPlanNudged: true },
		);
	if (!cooled) return { state: s };
	if (contextRatio !== null && cfg.contextRatio > 0 && contextRatio >= cfg.contextRatio && !s.ctxNudged) {
		const pct = Math.round(contextRatio * 100);
		const message = compact
			? `Baton: context is at ${pct}%. Call baton_plan (or baton_help if stuck) now; Baton will reset the context to task + plan.`
			: `Baton: context is at ${pct}%. Call baton_plan (or baton_help if stuck) now.`;
		return fire({ kind: "context", ratio: contextRatio, message }, { ctxNudged: true });
	}
	if (cfg.driftCalls > 0 && s.hasPlan && !s.driftNudged && s.toolCalls - s.lastStepAt >= cfg.driftCalls)
		return fire(
			{ kind: "drift", calls: s.toolCalls - s.lastStepAt, message: `Baton: ${s.toolCalls - s.lastStepAt} tool calls without baton_step. Check the pinned plan: mark finished steps with baton_step (with evidence); if the plan no longer fits, call baton_review or baton_plan.` },
			{ driftNudged: true },
		);
	if (cfg.remindEvery > 0 && s.toolCalls - s.lastAdvisorAt >= cfg.remindEvery && s.toolCalls - s.lastNudgeAt >= cfg.remindEvery)
		return fire(
			{ kind: "reminder", calls: s.toolCalls - s.lastAdvisorAt, message: `Baton: ${s.toolCalls - s.lastAdvisorAt} tool calls since the last advisor check. If you finished a milestone call baton_review; if stuck call baton_help.` },
			{},
		);
	return { state: s };
}

const GIT_COMMIT = /(^|[;&|()\s])git(\s+-[cC]\s+\S+)*\s+commit\b/;

export function isGitCommit(command: string): boolean {
	return GIT_COMMIT.test(command);
}

/** Pure: commit gate decision. */
export function commitGate(command: string, s: TriggerState, cfg: TriggerConfig): { block: true; reason: string } | undefined {
	if (!cfg.reviewBeforeCommit || !isGitCommit(command) || s.reviewPassed) return undefined;
	return { block: true, reason: "Baton: git commit is blocked until baton_review returns verdict on_track or done. Call baton_review first." };
}
