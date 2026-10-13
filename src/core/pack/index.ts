/**
 * Baton core: review-pack building, independent of pi. Use `buildReviewPack` to turn collected
 * context (see ./collect.ts) into chat messages for a tool-less advisor model.
 */
import { estimateTokens } from "../util.ts";
import { type AdvisorKind, fitSections, type Pack, type PackInput, packSections, type Section } from "./sections.ts";

export * from "./sections.ts";

export interface PackMessage {
	role: "system" | "user";
	content: string;
	/** True for the stable prefix (role + skills + AGENTS.md): mark it for prompt caching. */
	cache?: boolean;
}

export interface ReviewPack {
	kind: AdvisorKind;
	/** [system (stable, cacheable prefix), user (plan, task, artefacts, claims, instructions)]. */
	messages: PackMessage[];
	sections: { title: string; tokens: number; clipped: boolean; stable: boolean }[];
	tokens: number;
	/** Tokens of the stable prefix (what a cache hit saves). */
	stableTokens: number;
	overBudget: boolean;
}

function render(sections: Section[]): string {
	return sections.map((x) => `## ${x.title}\n${x.body}`).join("\n\n");
}

export const DEFAULT_PACK_BUDGET = 40_000;

/**
 * Build the advisor messages: a stable system prefix (role, project skills, AGENTS.md — identical
 * across calls of one kind on one repo, so it caches) and one user message with everything else,
 * ordered plan → task → artefacts → executor claims (unverified) → instructions + schema last.
 */
export function buildReviewPack(input: PackInput, opts: { budgetTokens?: number } = {}): ReviewPack {
	const budget = opts.budgetTokens ?? DEFAULT_PACK_BUDGET;
	const { sections, clipped } = fitSections(packSections(input), budget);
	const stable = sections.filter((x) => x.stable);
	const rest = sections.filter((x) => !x.stable);
	const system = render(stable);
	const user = `<baton_pack v="3" kind="${input.kind}"${input.reason ? ` reason="${input.reason}"` : ""}>\n${render(rest)}\n</baton_pack>`;
	const stableTokens = estimateTokens(system);
	const tokens = stableTokens + estimateTokens(user);
	return {
		kind: input.kind,
		messages: [
			{ role: "system", content: system, cache: true },
			{ role: "user", content: user },
		],
		sections: sections.map((x) => ({ title: x.title, tokens: estimateTokens(x.body), clipped: clipped.has(x.title), stable: !!x.stable })),
		tokens,
		stableTokens,
		overBudget: tokens > budget,
	};
}

/** Single-text form of the pack (debugging, `baton-pack --text`). */
export function buildPack(input: PackInput, budgetTokens: number = DEFAULT_PACK_BUDGET): Pack {
	const { sections, clipped } = fitSections(packSections(input), budgetTokens);
	const text = `<baton_pack v="3" kind="${input.kind}"${input.reason ? ` reason="${input.reason}"` : ""}>\n${render(sections)}\n</baton_pack>`;
	const tokens = estimateTokens(text);
	return {
		kind: input.kind,
		text,
		tokens,
		sections: sections.map((x) => ({ title: x.title, tokens: estimateTokens(x.body), clipped: clipped.has(x.title) })),
		overBudget: tokens > budgetTokens,
	};
}
