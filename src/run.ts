import type { BudgetLevel } from "./budget.ts";
import { type CallOutcome, callOutcome, callSignature, type ToolCall, type ToolOutput } from "./calls.ts";
import type { BatonConfig } from "./config.ts";

export interface RunCall {
	call: ToolCall;
	output?: ToolOutput;
	outcome: CallOutcome;
	blockedReason?: string;
}

export interface Checkpoint {
	tree?: string;
	unavailableReason?: string;
}

export interface SpeculativeRun {
	number: number;
	startedAt: number;
	maxSteps: number;
	steps: number;
	calls: RunCall[];
	checkpoint: Checkpoint;
	startProbability?: number;
	forcedStopReason?: string;
}

export interface FinishedRun {
	number: number;
	startTree?: string;
	endTree?: string;
	stopReason: string;
	steps: number;
	callCount: number;
	changedFiles: string[];
	rolledBack?: boolean;
}

export function startRun(number: number, now: number, config: Pick<BatonConfig, "steps">, checkpoint: Checkpoint, startProbability?: number): SpeculativeRun {
	return { number, startedAt: now, maxSteps: config.steps, steps: 0, calls: [], checkpoint, startProbability };
}

export function recordHelperTurn(run: SpeculativeRun, calls: ToolCall[], outputs: ToolOutput[], blockedReasons: ReadonlyMap<string, string>): void {
	run.steps++;
	const outputById = new Map(outputs.map((output) => [output.id, output]));
	for (const call of calls) {
		const blockedReason = blockedReasons.get(call.id);
		const output = outputById.get(call.id);
		const outcome: CallOutcome = blockedReason ? { status: "error", detail: `blocked by Baton: ${blockedReason}` } : callOutcome(call, output);
		run.calls.push({ call, output, outcome, blockedReason });
		if (blockedReason) run.forcedStopReason ??= `guardrail blocked ${call.name}: ${blockedReason}`;
	}
}

function repeatedCallCount(run: SpeculativeRun): number {
	const last = run.calls.at(-1);
	if (!last) return 0;
	const signature = callSignature(last.call);
	let count = 0;
	for (let index = run.calls.length - 1; index >= 0; index--) {
		const previous = run.calls[index]!;
		if (callSignature(previous.call) !== signature || previous.output?.text !== last.output?.text) break;
		count++;
	}
	return count;
}

export interface StopInput {
	now: number;
	turnHadToolCalls: boolean;
	turnFailed?: string;
	budget: BudgetLevel;
}

export function runStopReason(run: SpeculativeRun, config: Pick<BatonConfig, "maxRunMs" | "repeatLimit">, input: StopInput): string | undefined {
	if (input.turnFailed) return `the helper's request failed (${input.turnFailed})`;
	if (run.forcedStopReason) return run.forcedStopReason;
	if (input.budget === "wrapUp" || input.budget === "exhausted") return "the budget is nearly spent";
	if (!input.turnHadToolCalls) return "the helper stopped calling tools";
	const repeats = repeatedCallCount(run);
	if (repeats >= config.repeatLimit) return `the helper repeated the same call ${repeats} times with the same result`;
	if (run.steps >= run.maxSteps) return `step limit (${run.maxSteps}) reached`;
	if (input.now - run.startedAt >= config.maxRunMs) return `time limit (${Math.round(config.maxRunMs / 1000)} s) reached`;
	return undefined;
}

export interface StartInput {
	leadCalls: ToolCall[];
	cooldownLeft: number;
	budget: BudgetLevel;
	/** Jev's P(the lead makes more tool calls); undefined when Jev is off or failed. */
	probability?: number;
}

export type StartDecision = { start: true; reason: string } | { start: false; reason: string };

export function speculationDecision(input: StartInput, config: Pick<BatonConfig, "speculate" | "jev">): StartDecision {
	if (!config.speculate) return { start: false, reason: "speculation is off" };
	if (!input.leadCalls.length) return { start: false, reason: "the lead finished its turn without tool calls" };
	if (input.leadCalls.some((call) => call.name === "baton_rollback")) return { start: false, reason: "the lead is rolling back a run" };
	if (input.budget === "wrapUp" || input.budget === "exhausted") return { start: false, reason: "the budget is nearly spent" };
	if (input.cooldownLeft > 0) return { start: false, reason: "cooldown after the previous run" };
	if (input.probability === undefined) return { start: true, reason: config.jev.enabled ? "Jev unavailable; the lead's turn had tool calls" : "the lead's turn had tool calls" };
	if (input.probability < config.jev.threshold) return { start: false, reason: `Jev P(more calls) ${input.probability.toFixed(2)} < ${config.jev.threshold}` };
	return { start: true, reason: `Jev P(more calls) ${input.probability.toFixed(2)}` };
}
