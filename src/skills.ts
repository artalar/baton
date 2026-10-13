import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { charsForTokens, clip, estimateTokens } from "./util.ts";

export interface SkillDoc {
	name: string;
	description: string;
	/** Path relative to cwd. */
	path: string;
	body: string;
}

export const SKILL_DIRS = [".agents/skills", ".pi/skills", ".claude/skills", "skills"];

function frontmatter(text: string): { name?: string; description?: string } {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return {};
	const get = (k: string) => m[1]!.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");
	return { name: get("name"), description: get("description") };
}

/** Find project skills: <dir>/<skill>/SKILL.md for each known skills dir. */
export function discoverSkills(cwd: string, dirs: readonly string[] = SKILL_DIRS): SkillDoc[] {
	const out: SkillDoc[] = [];
	const seen = new Set<string>();
	for (const d of dirs) {
		const abs = join(cwd, d);
		if (!existsSync(abs)) continue;
		let entries: string[] = [];
		try {
			entries = readdirSync(abs);
		} catch {
			continue;
		}
		for (const e of entries.sort()) {
			const file = join(abs, e, "SKILL.md");
			if (!existsSync(file)) continue;
			try {
				const body = readFileSync(file, "utf8");
				const fm = frontmatter(body);
				const name = fm.name ?? e;
				if (seen.has(name)) continue;
				seen.add(name);
				out.push({ name, description: fm.description ?? "", path: `${d}/${e}/SKILL.md`, body });
			} catch {
				/* unreadable skill: skip */
			}
		}
	}
	return out;
}

/**
 * Pure: relevance score of a skill for a haystack (task, prompts, diff, imports).
 * Full-name hits weigh most; every name part (split on - _ /) must appear for a part score,
 * description keywords add a little.
 */
export function skillScore(s: SkillDoc, haystack: string): number {
	const h = haystack.toLowerCase();
	const name = s.name.toLowerCase();
	let score = 0;
	const count = (needle: string) => (needle.length < 3 ? 0 : h.split(needle).length - 1);
	score += Math.min(10, count(name)) * 3;
	const parts = name.split(/[-_/\s]+/).filter((p) => p.length >= 3);
	if (parts.length > 1 && parts.every((p) => count(p) > 0)) score += 2 * parts.length;
	else if (parts.length === 1 && score === 0 && count(parts[0]!) > 0) score += 2;
	const words = (s.description.toLowerCase().match(/[a-z@][a-z0-9@/._-]{4,}/g) ?? []).slice(0, 40);
	const kw = new Set(words);
	let d = 0;
	for (const w of kw) if (count(w) > 0) d++;
	score += Math.min(4, d) * 0.5;
	return score;
}

export interface SkillPick {
	skills: { name: string; path: string; body: string; score: number; clipped: boolean }[];
	tokens: number;
	skipped: string[];
}

/**
 * Pure: choose relevant skills for an advisor pack within `budgetTokens`.
 * `always` globs-like names (e.g. "*review*") are included for review packs when their topic matches
 * at least weakly (score>0) or when no other skill matched.
 */
export function selectSkills(all: readonly SkillDoc[], haystack: string, budgetTokens: number, opts: { maxSkills: number; prefer?: RegExp } = { maxSkills: 4 }): SkillPick {
	const raw = all.map((s) => ({ s, score: skillScore(s, haystack) + (opts.prefer?.test(s.name) ? 1.5 : 0) }));
	// Family bonus: when a skill matches strongly (e.g. "reatom"), its siblings ("reatom-async", "reatom-jsx")
	// are relevant too, even if the task text does not name their topic.
	const family = (n: string) => n.toLowerCase().split(/[-_/\s]+/)[0]!;
	const strong = new Set(raw.filter((x) => x.score >= 6).map((x) => family(x.s.name)));
	for (const x of raw) if (x.score < 2 && strong.has(family(x.s.name))) x.score = 2;
	const scored = raw
		.filter((x) => x.score >= 2)
		.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
	const chosen = scored.slice(0, opts.maxSkills).map(({ s, score }) => ({ name: s.name, path: s.path, body: s.body, score, clipped: false }));
	const skipped = scored.slice(opts.maxSkills).map((x) => x.s.name);
	const total = () => chosen.reduce((n, x) => n + estimateTokens(x.body), 0);
	// Over budget: clip the largest skill first (big review checklists), keep small focused ones whole.
	while (chosen.length && total() > budgetTokens) {
		const over = total() - budgetTokens;
		const big = chosen.reduce((a, b) => (estimateTokens(b.body) > estimateTokens(a.body) ? b : a));
		const bigT = estimateTokens(big.body);
		if (bigT - over >= 600) {
			big.body = clip(big.body, charsForTokens(bigT - over) - 60);
			big.clipped = true;
		} else {
			const low = chosen.reduce((a, b) => (b.score < a.score ? b : a));
			chosen.splice(chosen.indexOf(low), 1);
			skipped.push(low.name);
		}
	}
	return { skills: chosen, tokens: total(), skipped };
}
