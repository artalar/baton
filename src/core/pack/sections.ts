import { type JournalEvent, eventLine } from "../journal.ts";
import { REPLY_SCHEMA_TEXT } from "../schema.ts";
import { charsForTokens, clip, estimateTokens } from "../util.ts";

export type AdvisorKind = "review" | "help" | "plan";

export interface VerbatimCall {
	event: JournalEvent;
	args: string;
	output: string;
}

export interface PackInput {
	kind: AdvisorKind;
	reason?: string;
	task: string;
	userPrompts: { evt?: number; text: string }[];
	question?: string;
	// review
	diffStat?: string;
	diff?: string;
	changedFiles?: { path: string; content: string }[];
	lastTest?: VerbatimCall;
	// help
	lastCalls?: VerbatimCall[];
	sameErrorCalls?: VerbatimCall[];
	hypothesis?: string;
	attempts?: string[];
	important?: VerbatimCall[];
	// plan
	agentsMd?: string;
	repoMap?: string;
	// shared: selected project skills (SKILL.md bodies)
	skills?: { name: string; path: string; body: string }[];
	// shared
	timeline?: JournalEvent[];
	previousPlan?: string;
	/** Deferred (loop-detected) items the reviewer must rule on. */
	deferred?: string;
	/** Executor's own claims about its work (always presented as unverified). */
	claims?: string[];
}

export interface Section {
	title: string;
	body: string;
	/** 0 = never cut; higher = cut first. */
	cut: number;
	/** Part of the stable, cacheable prefix (role, project skills, AGENTS.md). */
	stable?: boolean;
}

export interface Pack {
	kind: AdvisorKind;
	text: string;
	tokens: number;
	sections: { title: string; tokens: number; clipped: boolean }[];
	overBudget: boolean;
}

const NO_TOOLS =
	"You have NO tools and everything you need is below: you cannot read files, list directories or run commands, and nobody will answer follow-up questions. Do not ask for files. If something you would need is missing, say so in `assessment` and lower your confidence instead of guessing.";

const ROLE: Record<AdvisorKind, string> = {
	review: `You are a senior reviewer. Below is a junior's work: it was produced by a junior executor (a different, cheaper model). Review the junior's work as a third party: you did not write it, and every claim the executor makes is unverified. Judge only the artefacts (diff, files, test output) against the task, the user's prompts, the pinned plan and the project skill rules. ${NO_TOOLS}`,
	help: `You are a senior debugging advisor. A junior executor (a different, cheaper model) is stuck. Below are its last tool calls verbatim, repeated errors, and its own hypothesis and attempts (unverified). Find the real cause, correct wrong beliefs, and give a short concrete plan. ${NO_TOOLS}`,
	plan: `You are a senior architect. A junior executor (a different, cheaper model) will implement the task below and has explored the repository. Using the project skill rules, the repository map and its findings, produce a short concrete plan with checkable done criteria, the architecture invariants it must keep and the skill rules it must follow. ${NO_TOOLS}`,
};

const INSTRUCTIONS: Record<AdvisorKind, string> = {
	review: `Checklist, in this order:
1. For every executor claim and every plan step marked done, confirm it by quoting the diff/test output, or refute it in facts_corrected. A claim without evidence in the artefacts is false.
2. Walk through the PROJECT SKILLS rules that apply to the changed code and list each violation with the offending line (non-idiomatic patterns count: e.g. raw timers/listeners/global mutable state where the skill prescribes its own primitives).
3. Check the task and every user prompt are satisfied; check the done criteria and invariants of the pinned plan.
4. If tests did not run after the last edits, the verdict cannot be "done".
5. Batch: put ALL fixes you want into this one reply (the executor cannot call you again until the review-verified steps are closed or a lot of code changed). Do not drip-feed 1-2 tiny steps per review.
6. Mark each step's verify: "self" for small/mechanical fixes (rename, cast removal, one-line fix, add a test the executor can run, docs, optional nits) — the executor does them, runs the check and marks them done, no re-review; "review" only for changes whose correctness you must see. Prefer "self".
7. Optional nits never block "done": if the work satisfies the task, return verdict done (any remaining nits as verify:"self" steps); after done the executor only commits.
verdict: done = complete and correct; on_track = correct so far; course_correct = fixable issues (put fixes in plan); replan = the approach is wrong.`,
	help: "Explain the root cause in assessment, correct wrong executor beliefs in facts_corrected (cite evt numbers), list approaches that must not be retried, and give the next steps.",
	plan: "Base the architecture on the PROJECT SKILLS rules (name the skill in each rule). Put architecture decisions in invariants, skill rules in rules, and the ids of steps after which a review is due in checkpoints (at least one, early: right after the core model works).",
};

function fmtCall(c: VerbatimCall): string {
	return `--- ${eventLine(c.event)}\nargs: ${c.args}\noutput:\n${c.output}`;
}

/**
 * Order follows long-context guidance: stable rules first (cacheable prefix), long data next,
 * the question and output format last. Executor statements are always marked unverified.
 */
export function packSections(i: PackInput): Section[] {
	const s: Section[] = [];
	// 1. stable, cacheable prefix: role -> project skills -> AGENTS.md
	s.push({ title: "ROLE", cut: 0, stable: true, body: ROLE[i.kind] });
	if (i.skills?.length)
		s.push({
			title: "PROJECT SKILLS (rules to check against)",
			cut: 3,
			stable: true,
			body: i.skills.map((k) => `<skill name="${k.name}" path="${k.path}">\n${k.body}\n</skill>`).join("\n\n"),
		});
	if (i.agentsMd) s.push({ title: "PROJECT RULES (AGENTS.md)", cut: 3, stable: true, body: i.agentsMd });
	// 2. plan (the contract), 3. task
	if (i.previousPlan) s.push({ title: i.kind === "review" ? "PINNED PLAN (review against it)" : "PREVIOUS ADVISOR PLAN", cut: 3, body: i.previousPlan });
	s.push({ title: "TASK (verbatim)", cut: 0, body: i.task || "(no task captured)" });
	if (i.userPrompts.length)
		s.push({ title: "USER PROMPTS (verbatim)", cut: 0, body: i.userPrompts.map((p) => `${p.evt ? `[evt#${p.evt}] ` : ""}${p.text}`).join("\n\n") });
	// 4. artefacts (long data)
	if (i.kind === "plan" && i.repoMap) s.push({ title: "REPO MAP", cut: 4, body: i.repoMap });
	if (i.diffStat) s.push({ title: "GIT DIFF --stat", cut: 0, body: i.diffStat });
	if (i.kind === "review") {
		if (i.changedFiles?.length) s.push({ title: "CHANGED FILES", cut: 4, body: i.changedFiles.map((f) => `<file path="${f.path}">\n${f.content}\n</file>`).join("\n\n") });
		if (i.diff !== undefined) s.push({ title: "GIT DIFF", cut: 2, body: i.diff || "(empty diff)" });
		s.push({ title: "LAST TEST RUN", cut: 1, body: i.lastTest ? fmtCall(i.lastTest) : "(no test run recorded)" });
	}
	if (i.kind === "help") {
		if (i.lastCalls?.length) s.push({ title: `LAST ${i.lastCalls.length} TOOL CALLS (verbatim)`, cut: 1, body: i.lastCalls.map(fmtCall).join("\n\n") });
		if (i.sameErrorCalls?.length) s.push({ title: "EARLIER CALLS WITH THE SAME ERROR SIGNATURE", cut: 2, body: i.sameErrorCalls.map(fmtCall).join("\n\n") });
		if (i.important?.length) s.push({ title: "EVENTS MARKED IMPORTANT BY EXECUTOR", cut: 2, body: i.important.map(fmtCall).join("\n\n") });
	}
	if (i.timeline?.length) s.push({ title: i.kind === "plan" ? "EXPLORATION FINDINGS (journal)" : "TIMELINE (importance ≥2)", cut: 3, body: i.timeline.map(eventLine).join("\n") });
	if (i.deferred)
		s.push({ title: "DEFERRED ITEMS (Baton loop detector; rule on each in deferred_rulings: unblock with guidance, drop, or keep)", cut: 0, body: i.deferred });
	// 5. executor claims, always unverified
	if (i.kind === "help") {
		if (i.hypothesis) s.push({ title: "EXECUTOR HYPOTHESIS (unverified)", cut: 0, body: i.hypothesis });
		if (i.attempts?.length) s.push({ title: "EXECUTOR ATTEMPTS (unverified)", cut: 0, body: i.attempts.map((a) => `- ${a}`).join("\n") });
	}
	const claims = [...(i.claims ?? []), ...(i.kind === "review" && i.question ? [i.question] : [])];
	if (claims.length) s.push({ title: "EXECUTOR CLAIMS (unverified)", cut: 0, body: claims.length === 1 ? claims[0]! : claims.map((c) => `- ${c}`).join("\n") });
	if (i.question && i.kind !== "review") s.push({ title: "QUESTION FROM EXECUTOR", cut: 0, body: i.question });
	// 6. instructions + schema last
	s.push({
		title: "INSTRUCTIONS",
		cut: 0,
		body: `${INSTRUCTIONS[i.kind]}\n${NO_TOOLS}\nReply with ONE JSON object only, no prose, in English, matching this schema. Be concise: assessment at most 3 sentences, at most 7 steps, each field at most 60 words, quote at most one line per finding. The reply must fit the output limit; a cut-off reply is wasted:\n${REPLY_SCHEMA_TEXT}`,
	});
	return s;
}

/** Fit sections into the budget (conservative estimateTokens) by clipping the most cuttable ones first. */
export function fitSections(sections: Section[], budgetTokens: number): { sections: Section[]; clipped: Set<string> } {
	const out = sections.map((x) => ({ ...x }));
	const clipped = new Set<string>();
	const total = () => out.reduce((n, x) => n + estimateTokens(x.body) + 8, 0);
	const order = out.filter((x) => x.cut > 0).sort((a, b) => b.cut - a.cut);
	// Several passes: non-ASCII text weighs more than charsForTokens assumes, so one pass may fall short.
	for (let pass = 0; pass < 3; pass++) for (const sec of order) {
		const over = total() - budgetTokens;
		if (over <= 0) break;
		if (sec.body === "(cut: over pack budget)") continue;
		const target = Math.max(0, sec.body.length - charsForTokens(over) - 64);
		sec.body = target < 200 ? "(cut: over pack budget)" : clip(sec.body, target);
		clipped.add(sec.title);
	}
	return { sections: out, clipped };
}

