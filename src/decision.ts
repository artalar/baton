import { callOutcome, oneLine, type ToolCall, type ToolOutput } from "./calls.ts";
import type { JevQuestions } from "./jev.ts";

export interface TurnRecord {
	by: "lead" | "helper";
	calls: { summary: string; status: string; tail: string }[];
}

export const SPECULATION_POLICY =
	"Two models share one coding-agent session. The lead model plans, writes and verifies the code. " +
	"After a lead turn with tool calls, the harness may let a cheap helper model continue the lead's current plan for a few tool calls " +
	"(more reads, the planned edits, running checks and fixing what they report). A run is worth it when the lead's next calls are a predictable continuation, " +
	"and not worth it when the lead is about to make a design decision, answer the user, or finish.";

export const MORE_CALLS_QUESTION: JevQuestions = {
	more_calls: {
		type: "noul",
		instructions:
			"After the lead's latest turn (`proposed_call`), the agent will make more tool calls that continue the current plan — reading, the planned edits, running checks — before it gives a final answer or needs a new design decision.",
	},
};

export function summarizeCall(call: ToolCall): string {
	const args = call.args;
	if (call.name === "bash") return `bash: ${String(args.command ?? "").slice(0, 400)}`;
	if (call.name === "read") return `read ${String(args.path ?? args.file_path ?? "")}`;
	if (call.name === "write") return `write ${String(args.path ?? args.file_path ?? "")} (${String(args.content ?? "").length} chars)`;
	if (call.name === "edit") {
		const edits = (Array.isArray(args.edits) ? args.edits : [{ oldText: args.oldText, newText: args.newText }]) as { oldText?: unknown; newText?: unknown }[];
		const preview = edits
			.slice(0, 2)
			.map((edit) => `-${JSON.stringify(String(edit.oldText ?? "").slice(0, 120))} +${JSON.stringify(String(edit.newText ?? "").slice(0, 160))}`)
			.join(" | ");
		return `edit ${String(args.path ?? args.file_path ?? "")}: ${preview}`;
	}
	return `${call.name} ${JSON.stringify(args).slice(0, 300)}`;
}

export function recordTurn(by: TurnRecord["by"], calls: ToolCall[], outputs: ToolOutput[], tailChars: number): TurnRecord {
	const outputById = new Map(outputs.map((output) => [output.id, output]));
	return {
		by,
		calls: calls.map((call) => {
			const output = outputById.get(call.id);
			const flattenedOutput = oneLine(output?.text ?? "", 100_000);
			return { summary: summarizeCall(call), status: callOutcome(call, output).status, tail: flattenedOutput.slice(-tailChars) };
		}),
	};
}

const renderTurn = (turn: TurnRecord) => turn.calls.map((call) => `[${turn.by}] ${call.summary} => ${call.status}${call.tail ? `: ${call.tail}` : ""}`).join("\n");

export function decisionState(task: string, recentTurns: TurnRecord[], latestLeadTurn: TurnRecord): Record<string, unknown> {
	return {
		policy: SPECULATION_POLICY,
		task: task.slice(0, 600),
		recent_turns: recentTurns.map(renderTurn),
		proposed_call: { model: "lead", call: renderTurn(latestLeadTurn).slice(0, 1200) },
	};
}
