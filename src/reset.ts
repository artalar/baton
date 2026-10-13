import { type JournalEvent, eventLine } from "./journal.ts";
import { clip } from "./util.ts";

/** Structural view of a pi SessionEntry. */
export interface EntryLike {
	id: string;
	type: string;
	message?: { role?: string };
}

/**
 * Pure: the entry id from which to keep history verbatim, so that the last `keepTurns`
 * assistant turns (with their tool results) survive. Returns null (keep nothing) if keepTurns is 0.
 */
export function pickFirstKept(entries: readonly EntryLike[], keepTurns: number): string | null {
	if (keepTurns <= 0) return null;
	const assistants = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
	if (!assistants.length) return entries.at(-1)?.id ?? null;
	return assistants[Math.max(0, assistants.length - keepTurns)]!.id;
}

export function resetSummary(opts: { task: string; plan: string; userPrompts?: string[]; diffStat?: string; note?: string }): string {
	const parts = [
		"# Baton context reset",
		"The earlier conversation was replaced by this summary. The full tool journal is in .pi/baton/events.jsonl; use baton_recall({evt}) to read any earlier output.",
		"## Task (verbatim)",
		clip(opts.task || "(unknown)", 12_000),
	];
	if (opts.userPrompts && opts.userPrompts.length > 1) parts.push("## Later user prompts (verbatim)", ...opts.userPrompts.slice(1).map((p) => clip(p, 4000)));
	if (opts.diffStat) parts.push("## git diff --stat", opts.diffStat);
	parts.push("## Current plan (follow it)", opts.plan);
	if (opts.note) parts.push(opts.note);
	return parts.join("\n\n");
}

/** Deterministic, no-LLM summary for pi's automatic compaction. */
export function autoCompactSummary(task: string, userPrompts: string[], lastPlan: string | undefined, timeline: JournalEvent[]): string {
	return resetSummary({
		task,
		userPrompts,
		plan: lastPlan ?? "(no advisor plan yet; call baton_plan if unsure how to continue)",
		note: timeline.length ? `## Timeline (importance ≥2)\n${clip(timeline.map(eventLine).join("\n"), 12_000)}` : undefined,
	});
}
