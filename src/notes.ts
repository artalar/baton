import type { RunCall } from "./run.ts";

export const ALERT_INTRO =
	"[speculative automation alert] Execution was switched automatically to a weaker, cheaper model to save cost. The tool calls below are the complete record of what it did. Do not re-read the files just to reconstruct that record. Judge the changes strictly and decide whether to accept them. Optimizing model tool calls:";

export function leadSystemNote(): string {
	return "After a turn of yours that uses tools, a cheaper model may continue the task in this session. A speculative automation alert means that work is already in the transcript. Judge it strictly and decide whether to accept it.";
}

export function followerSystemNote(): string {
	return "Continue the work already in the context. Use the normal tools. When that work is done, or the next step needs a decision you cannot make, stop without a tool call.";
}

export function renderAlert(calls: readonly RunCall[]): string {
	if (!calls.length) return ALERT_INTRO;
	const lines = calls.map((call, index) => `${index + 1}. ${call.name}\ninput: ${JSON.stringify(call.args)}\noutput: ${call.output ?? ""}`);
	return `${ALERT_INTRO}\n${lines.join("\n")}`;
}
