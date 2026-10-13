import { describeCall, isReadOnly, oneLine } from "./calls.ts";
import { type CheckResult, describeCheck } from "./checks.ts";
import type { BatonConfig } from "./config.ts";
import type { ChangedPath } from "./git.ts";
import type { FinishedRun, RunCall, SpeculativeRun } from "./run.ts";

export const HARNESS = "[Baton harness]";

export const LEAD_SYSTEM_NOTE = `

# Baton: speculative execution
This session runs under Baton, and you are the lead model. To save cost, after some of your turns the harness lets a cheaper helper model continue your work in this same session for a few steps: a speculative run. The helper sees everything you see and continues your current plan: more reads, the edits you planned, running checks and fixing what they report.
You never see the helper's own messages. After each run you get a message starting with "${HARNESS} Speculative run #N". The harness writes it from facts only: the helper's tool calls and their outcomes, read outputs verbatim, the diff of the run, and the results of checks the harness ran itself (typecheck, tests, build). The helper's claims are not included.
- That work was done by the helper, not by you. Review the diff before you build on it. If the run went the wrong way, call baton_rollback({run: N}): it restores the files the run changed to the checkpoint taken before the run.
- Do not redo what the run already did correctly; continue from where it stopped.
- You own the final verification. Before your final answer, make sure typecheck, tests and the production build pass. When you finish, the harness runs these checks and sends you back if any fails.`;

export function helperInstruction(run: SpeculativeRun, lastLeadCalls: string[]): string {
	return [
		`${HARNESS} Speculative run #${run.number}. You are now the helper model. Continue the lead model's work from exactly where it stopped, as the lead would: the next tool calls of its current plan, for up to ${run.maxSteps} turns. Batch independent tool calls in one turn.`,
		`The lead's last calls: ${lastLeadCalls.join("; ") || "(none)"}.`,
		"Rules:",
		"- Follow the lead's plan, names and interfaces. Do not redesign and do not start work the lead has not planned.",
		"- Do not rewrite or delete existing files and tests: create new files and make targeted edits. Never skip, weaken or delete tests.",
		"- No git commands that change history or discard work, no dependency version changes.",
		"- When the next step needs a design decision or the user, or the plan is done, stop: reply with one short line and no tool call.",
		"The lead does not read your messages. The harness reports your tool calls and their results, and runs typecheck, tests and build after your run.",
	].join("\n");
}

export interface RunFacts {
	stopReason: string;
	changedFiles?: ChangedPath[];
	diff?: string;
	diffUnavailableReason?: string;
	checks?: CheckResult[];
	checksSkippedReason?: string;
}

const clip = (text: string, maxChars: number, hint: string) => (text.length > maxChars ? `${text.slice(0, maxChars)}\n[… ${text.length - maxChars} more characters clipped — ${hint}]` : text);

const STATUS_TEXT = { ok: "ok", error: "ERROR", suspect: "UNRELIABLE" } as const;

function callLine(runCall: RunCall, index: number, config: BatonConfig, readOutputShown: boolean): string {
	const { call, output, outcome } = runCall;
	const base = `${index + 1}. ${describeCall(call)} → ${STATUS_TEXT[outcome.status]}${outcome.detail ? ` — ${outcome.detail}` : ""}`;
	if (runCall.blockedReason || !output || config.transcript === "full" || call.name === "edit" || call.name === "write") return base;
	if (isReadOnly(call)) return readOutputShown ? `${base} (output below)` : base;
	const tail = output.text.trim();
	if (!tail) return base;
	return `${base}\n   output tail: ${oneLine(tail.slice(-config.commandTailChars), config.commandTailChars)}`;
}

function verbatimOutputs(calls: RunCall[], config: BatonConfig): { sections: string[]; shown: Set<RunCall> } {
	const shown = new Set<RunCall>();
	const sections: string[] = [];
	const seen = new Set<string>();
	let budget = config.transcript === "full" ? Number.POSITIVE_INFINITY : config.readChars;
	for (const runCall of calls) {
		const { call, output, blockedReason } = runCall;
		if (!output || blockedReason) continue;
		if (config.transcript === "facts" && (!isReadOnly(call) || output.isError)) continue;
		const key = `${describeCall(call, 10_000)}\u0000${output.text}`;
		if (seen.has(key)) {
			shown.add(runCall);
			continue;
		}
		seen.add(key);
		if (output.text.length > budget) {
			sections.push(`--- ${describeCall(call)} ---\n[omitted: read budget exhausted — read it yourself if you need it]`);
			continue;
		}
		budget -= output.text.length;
		shown.add(runCall);
		sections.push(`--- ${describeCall(call)} ---\n${output.text}`);
	}
	return { sections, shown };
}

function changesSection(facts: RunFacts, config: BatonConfig): string {
	if (facts.diffUnavailableReason) return `Changes: unknown — ${facts.diffUnavailableReason}.`;
	const files = facts.changedFiles ?? [];
	if (!files.length) return "Changes: the run changed no files.";
	const fileList = files.map((file) => `- ${file.status} ${file.path}`).join("\n");
	const diffLimit = config.transcript === "full" ? config.noteChars : config.diffChars;
	return `Files changed by the run (${files.length}):\n${fileList}\n\nDiff of the run (checkpoint → end of run):\n${clip(facts.diff ?? "", diffLimit, "run the git diff command below for the rest")}`;
}

function checksSection(facts: RunFacts): string {
	if (facts.checksSkippedReason) return `Checks run by the harness: none — ${facts.checksSkippedReason}.`;
	const checks = facts.checks ?? [];
	if (!checks.length) return "Checks run by the harness: none (no typecheck, test or build script found).";
	const verdict = checks.every((check) => check.passed) ? "all passed" : "SOME FAILED";
	return `Checks run by the harness after the run (${verdict}):\n${checks.map((check) => describeCheck(check)).join("\n")}`;
}

function checkpointSection(run: SpeculativeRun, endTree: string | undefined): string {
	if (!run.checkpoint.tree) return `Checkpoint: none (${run.checkpoint.unavailableReason ?? "unavailable"}), so this run cannot be rolled back automatically.`;
	const inspect = endTree ? ` To inspect it: \`git diff ${run.checkpoint.tree} ${endTree}\`.` : "";
	return `Checkpoint: the working tree before the run is saved as git tree ${run.checkpoint.tree}. To undo this run, call baton_rollback({run: ${run.number}}).${inspect}`;
}

export function renderRunNote(run: SpeculativeRun, facts: RunFacts, config: BatonConfig, endTree?: string): string {
	const helperName = config.helper.split("/").pop();
	const { sections: outputs, shown } = verbatimOutputs(run.calls, config);
	const callLines = run.calls.map((runCall, index) => callLine(runCall, index, config, shown.has(runCall)));
	const outputsTitle = config.transcript === "full" ? "Full outputs of the helper's calls (verbatim)" : "Read outputs (verbatim)";
	const note = [
		`${HARNESS} Speculative run #${run.number} — performed by the helper model (${helperName}), not by you.`,
		`After your last tool call the harness let the helper continue your work in this session: ${run.steps} turn(s), ${run.calls.length} tool call(s). It stopped because ${facts.stopReason}. The helper's messages are hidden from you; everything below was collected by the harness.`,
		checkpointSection(run, endTree),
		`Tool calls of the helper:\n${callLines.join("\n") || "(none)"}`,
		changesSection(facts, config),
		checksSection(facts),
		...(outputs.length ? [`${outputsTitle}:\n${outputs.join("\n")}`] : []),
		"Continue the task from here. You are responsible for this work: review the diff, fix what is wrong or roll the run back, and make sure typecheck, tests and the build pass before you finish.",
	].join("\n\n");
	if (note.length <= config.noteChars) return note;
	const footer = "\n\n[… note clipped by the harness]\n\nContinue the task from here. Review the diff, fix or roll back, and verify before you finish.";
	return note.slice(0, config.noteChars - footer.length) + footer;
}

export function renderFinalChecksNote(checks: CheckResult[], round: number, maxRounds: number): string {
	const failed = checks.filter((check) => !check.passed);
	return [
		`${HARNESS} Final checks — run by the harness after your final answer (round ${round} of ${maxRounds}). ${failed.length} of ${checks.length} failed:`,
		checks.map((check) => describeCheck(check, 2_000)).join("\n"),
		"The task is not done while these fail. Fix the cause, or, if a failure is expected and unrelated to the task, say so explicitly in your final answer.",
	].join("\n\n");
}

export function renderBudgetNote(spentUsd: number, budgetUsd: number): string {
	return `${HARNESS} Budget: about $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} is spent. No more speculative runs in this task. Finish now: complete the remaining essential steps, verify typecheck, tests and the build, and give your final answer.`;
}

export function renderRollbackResult(run: FinishedRun, result: { restored: string[]; removed: string[]; keptChangedLater: string[]; error?: string }): string {
	if (result.error) return `baton_rollback: run #${run.number} was NOT rolled back: ${result.error}.`;
	const lines = [`baton_rollback: run #${run.number} rolled back to its checkpoint ${run.startTree}.`];
	if (result.restored.length) lines.push(`Restored: ${result.restored.join(", ")}`);
	if (result.removed.length) lines.push(`Deleted (created by the run): ${result.removed.join(", ")}`);
	if (result.keptChangedLater.length) lines.push(`Left as they are (changed after the run): ${result.keptChangedLater.join(", ")}`);
	if (!result.restored.length && !result.removed.length) lines.push("The run changed no files that could be restored.");
	return lines.join("\n");
}
