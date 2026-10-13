import { type JournalEvent, eventLine } from "./journal.ts";
import { REPLY_SCHEMA_TEXT } from "./schema.ts";
import { clip, estimateTokens } from "./util.ts";

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
	// shared
	timeline?: JournalEvent[];
	previousPlan?: string;
}

export interface Section {
	title: string;
	body: string;
	/** 0 = never cut; higher = cut first. */
	cut: number;
}

export interface Pack {
	kind: AdvisorKind;
	text: string;
	tokens: number;
	sections: { title: string; tokens: number; clipped: boolean }[];
	overBudget: boolean;
}

const ROLE: Record<AdvisorKind, string> = {
	review:
		"You are a senior reviewer. A cheaper executor model did the work below. Check it against the task and the user's prompts, using only the diff, files and test output (the executor's own narrative is excluded on purpose). Decide whether it is done and correct.",
	help: "You are a senior debugging advisor. A cheaper executor model is stuck. You see its last tool calls verbatim, repeated errors, its hypothesis and attempts. Find the real cause, correct wrong beliefs, and give a short concrete plan.",
	plan: "You are a senior planner. A cheaper executor model is about to work on the task below. Using the project rules and repository map, produce a short concrete plan with checkable done criteria.",
};

function fmtCall(c: VerbatimCall): string {
	return `--- ${eventLine(c.event)}\nargs: ${c.args}\noutput:\n${c.output}`;
}

export function packSections(i: PackInput): Section[] {
	const s: Section[] = [];
	s.push({
		title: "ROLE",
		cut: 0,
		body: `${ROLE[i.kind]}\nReply with ONE JSON object only, no prose, matching this schema (every plan step needs done_when; at most 7 steps):\n${REPLY_SCHEMA_TEXT}`,
	});
	s.push({ title: "TASK (verbatim)", cut: 0, body: i.task || "(no task captured)" });
	if (i.userPrompts.length)
		s.push({ title: "USER PROMPTS (verbatim)", cut: 0, body: i.userPrompts.map((p) => `${p.evt ? `[evt#${p.evt}] ` : ""}${p.text}`).join("\n\n") });
	if (i.question) s.push({ title: "QUESTION FROM EXECUTOR", cut: 0, body: i.question });

	if (i.kind === "plan") {
		if (i.agentsMd) s.push({ title: "PROJECT RULES (AGENTS.md)", cut: 3, body: i.agentsMd });
		if (i.repoMap) s.push({ title: "REPO MAP", cut: 4, body: i.repoMap });
	}
	if (i.kind === "review" || i.kind === "help") {
		if (i.diffStat) s.push({ title: "GIT DIFF --stat", cut: 0, body: i.diffStat });
	}
	if (i.kind === "review") {
		if (i.diff !== undefined) s.push({ title: "GIT DIFF", cut: 2, body: i.diff || "(empty diff)" });
		if (i.changedFiles?.length) s.push({ title: "CHANGED FILES", cut: 4, body: i.changedFiles.map((f) => `=== ${f.path}\n${f.content}`).join("\n\n") });
		s.push({ title: "LAST TEST RUN", cut: 1, body: i.lastTest ? fmtCall(i.lastTest) : "(no test run recorded)" });
	}
	if (i.kind === "help") {
		if (i.hypothesis) s.push({ title: "EXECUTOR HYPOTHESIS (unverified)", cut: 0, body: i.hypothesis });
		if (i.attempts?.length) s.push({ title: "EXECUTOR ATTEMPTS (unverified)", cut: 0, body: i.attempts.map((a) => `- ${a}`).join("\n") });
		if (i.lastCalls?.length) s.push({ title: `LAST ${i.lastCalls.length} TOOL CALLS (verbatim)`, cut: 1, body: i.lastCalls.map(fmtCall).join("\n\n") });
		if (i.sameErrorCalls?.length) s.push({ title: "EARLIER CALLS WITH THE SAME ERROR SIGNATURE", cut: 2, body: i.sameErrorCalls.map(fmtCall).join("\n\n") });
		if (i.important?.length) s.push({ title: "EVENTS MARKED IMPORTANT BY EXECUTOR", cut: 2, body: i.important.map(fmtCall).join("\n\n") });
	}
	if (i.timeline?.length) s.push({ title: "TIMELINE (importance ≥2)", cut: 3, body: i.timeline.map(eventLine).join("\n") });
	if (i.previousPlan) s.push({ title: "PREVIOUS ADVISOR PLAN", cut: 3, body: i.previousPlan });
	return s;
}

/** Fit sections into the budget (tokens ≈ chars/4) by clipping the most cuttable ones first. */
export function fitSections(sections: Section[], budgetTokens: number): { sections: Section[]; clipped: Set<string> } {
	const out = sections.map((x) => ({ ...x }));
	const clipped = new Set<string>();
	const total = () => out.reduce((n, x) => n + estimateTokens(x.body) + 8, 0);
	const order = out.filter((x) => x.cut > 0).sort((a, b) => b.cut - a.cut);
	for (const sec of order) {
		const over = total() - budgetTokens;
		if (over <= 0) break;
		const target = Math.max(0, sec.body.length - over * 4);
		sec.body = target < 200 ? "(cut: over pack budget)" : clip(sec.body, target);
		clipped.add(sec.title);
	}
	return { sections: out, clipped };
}

export function buildPack(input: PackInput, budgetTokens: number): Pack {
	const { sections, clipped } = fitSections(packSections(input), budgetTokens);
	const body = sections.map((x) => `## ${x.title}\n${x.body}`).join("\n\n");
	const text = `<baton_pack v="1" kind="${input.kind}"${input.reason ? ` reason="${input.reason}"` : ""}>\n${body}\n</baton_pack>`;
	const tokens = estimateTokens(text);
	return {
		kind: input.kind,
		text,
		tokens,
		sections: sections.map((x) => ({ title: x.title, tokens: estimateTokens(x.body), clipped: clipped.has(x.title) })),
		overBudget: tokens > budgetTokens,
	};
}
