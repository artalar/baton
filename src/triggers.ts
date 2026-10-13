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
}

export function initialTriggerState(): TriggerState {
	return { toolCalls: 0, lastAdvisorAt: 0, lastNudgeAt: -Infinity, errCounts: {}, nudgedSigs: [], reviewPassed: false, ctxNudged: false };
}

export type Nudge =
	| { kind: "context"; ratio: number; message: string }
	| { kind: "same_error"; sig: string; count: number; message: string }
	| { kind: "reminder"; calls: number; message: string };

const ADVISOR_TOOLS = new Set(["baton_review", "baton_help", "baton_plan"]);

/** Pure reducer: account for one finished tool call. */
export function onToolResult(s: TriggerState, tool: string, errSig: string | null | undefined, wroteFile: boolean): TriggerState {
	const n: TriggerState = { ...s, errCounts: { ...s.errCounts }, toolCalls: s.toolCalls + 1 };
	if (ADVISOR_TOOLS.has(tool)) n.lastAdvisorAt = n.toolCalls;
	if (errSig) n.errCounts[errSig] = (n.errCounts[errSig] ?? 0) + 1;
	if (wroteFile) n.reviewPassed = false; // new edits invalidate a previous review
	return n;
}

export function onAdvisor(s: TriggerState, kind: "review" | "help" | "plan", verdict: string): TriggerState {
	const n = { ...s, lastAdvisorAt: s.toolCalls };
	if (kind === "review") n.reviewPassed = verdict === "on_track" || verdict === "done";
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
export function evaluate(s: TriggerState, cfg: TriggerConfig, contextRatio: number | null): { nudge?: Nudge; state: TriggerState } {
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
	if (!cooled) return { state: s };
	if (contextRatio !== null && cfg.contextRatio > 0 && contextRatio >= cfg.contextRatio && !s.ctxNudged)
		return fire(
			{ kind: "context", ratio: contextRatio, message: `Baton: context is at ${Math.round(contextRatio * 100)}%. Call baton_plan (or baton_help if stuck) now; Baton will reset the context to task + plan.` },
			{ ctxNudged: true },
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
