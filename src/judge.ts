import type { JournalEvent } from "./journal.ts";
import { eventLine } from "./journal.ts";

export type JudgeDecision = "include" | "drop";

/** Jev-style typed question: a choice between labelled criteria. */
export interface JudgeQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

/** Provider interface in the Jev request/response shape (state + typed questions → probabilities). */
export interface JudgeProvider {
	readonly name: string;
	decide(
		request: { state: Record<string, unknown>; questions: Record<string, JudgeQuestion> },
		signal?: AbortSignal,
	): Promise<Record<string, { choice: string; confidence: number }> | undefined>;
}

export const INCLUDE_QUESTION: JudgeQuestion = {
	type: "choice",
	instructions: "Does the advisor need the event in `event` (one line from the agent's tool journal) to plan the next step for `task`?",
	criteria: {
		must: "Needed: evidence of the current state, a failure cause, or a constraint",
		useful: "Helpful context but not essential",
		noise: "Not needed: routine listing, repeated or superseded output",
	},
};

/** Heuristic fallback: medium events (importance 1–2) are included iff importance is 2. */
export function heuristicDecision(e: JournalEvent): JudgeDecision {
	return (e.importance ?? 1) >= 2 ? "include" : "drop";
}

/**
 * Filter events for the pack timeline. Only medium-importance events (1–2) go to the judge;
 * importance 3 is always included, 0 always dropped. A low-confidence or failed judge answer
 * falls back to the heuristic.
 */
export async function filterEvents(
	events: JournalEvent[],
	task: string,
	judge: JudgeProvider | undefined,
	minConfidence: number,
	signal?: AbortSignal,
): Promise<{ kept: JournalEvent[]; judged: number }> {
	const kept: JournalEvent[] = [];
	const medium = events.filter((e) => e.importance === 1 || e.importance === 2);
	const decisions = new Map<number, JudgeDecision>();
	if (judge && medium.length) {
		await Promise.all(
			medium.map(async (e) => {
				try {
					const ans = await judge.decide({ state: { task: task.slice(0, 4000), event: eventLine(e) }, questions: { include: INCLUDE_QUESTION } }, signal);
					const a = ans?.include;
					if (a && a.confidence >= minConfidence) decisions.set(e.evt, a.choice === "noise" ? "drop" : "include");
				} catch {
					/* fallback below */
				}
			}),
		);
	}
	for (const e of events) {
		const imp = e.importance ?? 1;
		if (imp >= 3) kept.push(e);
		else if (imp === 0) continue;
		else if ((decisions.get(e.evt) ?? heuristicDecision(e)) === "include") kept.push(e);
	}
	return { kept, judged: decisions.size };
}
