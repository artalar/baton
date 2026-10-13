/**
 * Review gating (v0.5): stop review ping-pong. A self-invoked baton_review is refused unless the
 * steps the previous review issued are closed or enough change accumulated; after a "done" verdict
 * Baton enters finalize mode (commit only). Pure functions; forced handoffs never pass through here.
 */
import { BASH_INSPECT_SEG, isGitCommit } from "./triggers.ts";

export interface ReviewGateConfig {
	/** Gate self-invoked baton_review / baton_help. */
	enabled: boolean;
	/** Changed lines (git diff --numstat, added+deleted) since the last review that permit a new one. */
	minDiffLines: number;
	/** Executor tool calls (non-Baton) since the last review that permit a new one. */
	minCalls: number;
	/** Executor tool calls required between an advisor call and a self-invoked baton_help. */
	helpMinCalls: number;
	/** After a "done" verdict: commit-only finalize mode. */
	finalizeAfterDone: boolean;
}

export type Verify = "self" | "review";

export interface GateStep {
	id: string;
	verify: Verify;
}

export interface GateState {
	lastReview?: { atCalls: number; tree?: string; steps: GateStep[]; verdict: string };
	/** Executor call count at the last advisor call of any kind. */
	lastAdvisorAt: number;
	finalize: boolean;
	/** The one-time finalize edit block already fired. */
	finalizeWarned: boolean;
}

export function initialGateState(): GateState {
	return { lastAdvisorAt: 0, finalize: false, finalizeWarned: false };
}

const closed = (st: string | undefined) => st === "done" || st === "deferred";

/** Pure: account for an advisor reply (any kind, forced or not). */
export function gateOnAdvisor(g: GateState, kind: "review" | "help" | "plan", verdict: string, steps: readonly { id: string; verify?: Verify }[], calls: number, tree: string | undefined, cfg: ReviewGateConfig): GateState {
	const n: GateState = { ...g, lastAdvisorAt: calls };
	if (kind === "review") {
		n.lastReview = { atCalls: calls, tree, steps: steps.map((s) => ({ id: s.id, verify: s.verify ?? "review" })), verdict };
		n.finalize = cfg.finalizeAfterDone && verdict === "done";
		n.finalizeWarned = false;
	} else {
		// a new plan/help supersedes the review's step list
		n.lastReview = g.lastReview ? { ...g.lastReview, steps: [] , verdict: "superseded" } : undefined;
	}
	return n;
}

/** Pure: a successful git commit or a new user prompt ends finalize mode. */
export function gateReleaseFinalize(g: GateState): GateState {
	return g.finalize ? { ...g, finalize: false, finalizeWarned: false } : g;
}

export interface GateFacts {
	/** Executor (non-Baton) tool calls so far. */
	calls: number;
	/** Changed lines since the last review; undefined when unknown. */
	diffLines?: number;
	/** Step status by id (baton_step). */
	status: Record<string, string>;
}

export type GateDecision = { allow: true; why: string } | { allow: false; reason: string };

/** Open review-verified steps of the last review. */
export function openReviewSteps(g: GateState, status: Record<string, string>): string[] {
	return (g.lastReview?.steps ?? []).filter((s) => s.verify === "review" && !closed(status[s.id])).map((s) => s.id);
}

/** Pure: may the executor call baton_review now? `needDiff` tells the caller to compute diffLines and ask again. */
export function reviewGate(g: GateState, cfg: ReviewGateConfig, f: GateFacts): GateDecision & { needDiff?: boolean } {
	if (!cfg.enabled) return { allow: true, why: "gate off" };
	if (g.finalize)
		return { allow: false, reason: "Baton: the last review returned verdict done. Do not request another review: run the final checks if needed (tsc/test/build) and git commit now. A new review is possible after the commit or when the user asks." };
	const lr = g.lastReview;
	if (!lr || lr.verdict === "superseded") return { allow: true, why: "no previous review steps" };
	const reviewSteps = lr.steps.filter((s) => s.verify === "review");
	const open = openReviewSteps(g, f.status);
	if (reviewSteps.length && !open.length) return { allow: true, why: "all review steps closed" };
	const calls = f.calls - lr.atCalls;
	if (cfg.minCalls > 0 && calls >= cfg.minCalls) return { allow: true, why: `${calls} calls since last review` };
	if (cfg.minDiffLines > 0 && f.diffLines === undefined) return { allow: false, reason: "", needDiff: true };
	if (cfg.minDiffLines > 0 && (f.diffLines ?? 0) >= cfg.minDiffLines) return { allow: true, why: `${f.diffLines} changed lines since last review` };
	const selfOpen = lr.steps.filter((s) => s.verify === "self" && !closed(f.status[s.id])).map((s) => s.id);
	const what = open.length
		? `Finish the steps from the last review first: ${open.join(", ")} (mark each with baton_step done/deferred), then call baton_review once for all of them.`
		: `The remaining steps${selfOpen.length ? ` (${selfOpen.join(", ")})` : ""} are marked verify:self — do them, mark them done with baton_step, then git commit (no review needed).`;
	return { allow: false, reason: `Baton: baton_review refused — ${what} A review is also allowed after ${cfg.minCalls} tool calls or ${cfg.minDiffLines} changed lines since the last one (now ${calls} calls${f.diffLines !== undefined ? `, ${f.diffLines} lines` : ""}). If you are stuck, use baton_help.` };
}

/** Pure: may the executor call baton_help now? */
export function helpGate(g: GateState, cfg: ReviewGateConfig, calls: number): GateDecision {
	if (!cfg.enabled || cfg.helpMinCalls <= 0) return { allow: true, why: "gate off" };
	const since = calls - g.lastAdvisorAt;
	if (g.lastAdvisorAt > 0 && since < cfg.helpMinCalls)
		return { allow: false, reason: `Baton: baton_help refused — only ${since} tool call(s) since the last advisor reply. Apply its plan first (at least ${cfg.helpMinCalls} calls); if a step really cannot be done, mark it blocked/deferred with baton_step and move on.` };
	return { allow: true, why: `${since} calls since last advisor` };
}

/** Pure: commit is allowed regardless of reviewPassed (finalize mode, or a review whose steps were all verify:self and are closed). */
export function commitAllowedByGate(g: GateState, status: Record<string, string>): boolean {
	if (g.finalize) return true;
	const lr = g.lastReview;
	if (!lr || !lr.steps.length || lr.verdict === "replan" || lr.verdict === "need_user" || lr.verdict === "superseded") return false;
	return lr.steps.every((s) => s.verify === "self" && closed(status[s.id]));
}

const VERIFY_CMD = /\b(tsc|vitest|jest|mocha|pytest|go (test|build|vet)|cargo (test|build|check|clippy)|npm (run |)(test|build|typecheck|check|lint)|pnpm (run )?(test|build|typecheck|check|lint)|yarn (test|build|typecheck|lint)|bun (run )?(test|build)|vite build|eslint|biome|prettier --check)\b/;
const GIT_OK = /^\s*git(\s+-[cC]\s+\S+)*\s+(add|status|diff|log|show|commit|rev-parse)\b/;

/** Pure: is this bash command allowed in finalize mode (verification, inspection, git add/commit)? */
export function finalizeAllowedBash(cmd: string): boolean {
	if (isGitCommit(cmd)) return true;
	if (/(^|[^0-9&])>(?!&)|\btee\b|\bsed\s+-i|\brm\s|\bmv\s|\bcp\s/.test(cmd.replace(/[12]?>\s*\/dev\/null|2>&1/g, ""))) return false;
	return cmd
		.split(/&&|\|\||;|\|/)
		.map((s) => s.trim().replace(/^(set -o pipefail|cd \S+|npx( -y)?)\s*/g, "").trim())
		.filter(Boolean)
		.every((seg) => VERIFY_CMD.test(seg) || GIT_OK.test(seg) || BASH_INSPECT_SEG.test(seg) || /^(set -o pipefail|cd \S+|echo\b)/.test(seg));
}

/** Pure: in finalize mode, block the first edit/write or non-verification bash once. */
export function finalizeGate(tool: string, cmd: string | undefined, g: GateState): { block: true; reason: string } | undefined {
	if (!g.finalize || g.finalizeWarned) return undefined;
	const edit = tool === "write" || tool === "edit";
	const badBash = tool === "bash" && !!cmd && !finalizeAllowedBash(cmd);
	if (!edit && !badBash) return undefined;
	return { block: true, reason: "Baton: the review verdict is done — the work is finished. Do not change code now: run git add + git commit (final tsc/test/build checks are fine). Optional nits from the reviewer can wait. If this change is truly required, retry it; this block fires once, and baton_review stays refused until you commit." };
}
