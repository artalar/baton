/**
 * Collect review/help/plan context from a repository and (optionally) a Baton journal.
 * Pure Node: git through an injectable `Exec`, defaulting to child_process.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type JournalEvent, eventLine } from "../journal.ts";
import { changedFiles, type Exec, git, packDiff, packExcludes, readAgentsMd, repoMap } from "../repo.ts";
import { discoverSkills, SKILL_DIRS, selectSkills } from "../skills.ts";
import { clip } from "../util.ts";
import type { AdvisorKind, PackInput, VerbatimCall } from "./sections.ts";

export function nodeExec(cwd: string): Exec {
	return (cmd, args) =>
		new Promise((resolve) => {
			execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 20_000 }, (err, stdout) => {
				const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
				resolve({ stdout: String(stdout ?? ""), code });
			});
		});
}

/** Minimal read access to a journal (Baton's Journal class satisfies it). */
export interface JournalLike {
	toolEvents(): JournalEvent[];
	raw(evt: number): string | undefined;
	get(evt: number): JournalEvent | undefined;
}

export interface CollectOptions {
	kind: AdvisorKind;
	cwd: string;
	task: string;
	userPrompts?: { evt?: number; text: string }[];
	exec?: Exec;
	journal?: JournalLike;
	/** Rendered pinned plan (review is checked against it). */
	plan?: string;
	/** Executor claims (always rendered as unverified). */
	claims?: string[];
	question?: string;
	reason?: string;
	/** help only */
	hypothesis?: string;
	attempts?: string[];
	importantEvts?: number[];
	helpLastCalls?: number;
	deferred?: string;
	excludePaths?: readonly string[];
	journalDir?: string;
	skills?: { enabled?: boolean; dirs?: readonly string[]; maxSkills?: number; budgetTokens?: number };
	/** Pack budget; skills get skills.budgetTokens or 35% of it. */
	budgetTokens?: number;
}

export function verbatimCall(journal: JournalLike, e: JournalEvent, maxChars = 6000): VerbatimCall {
	return { event: e, args: e.argsDigest ?? "", output: clip(journal.raw(e.evt) ?? `${e.outHead ?? ""}\n${e.outTail ?? ""}`, maxChars) };
}

/** Timeline filter: importance ≥2 (failures, edits, tests, notes); 3 always, 0/1 never. */
export function timelineEvents(events: readonly JournalEvent[]): JournalEvent[] {
	return events.filter((e) => (e.importance ?? 1) >= 2);
}

/** Gather everything the pack needs: diff, changed files, last test, skills, AGENTS.md, plan, claims. */
export async function collectPackInput(o: CollectOptions): Promise<PackInput> {
	const exec = o.exec ?? nodeExec(o.cwd);
	const excludes = packExcludes(o.journalDir ?? ".pi/baton", o.excludePaths ?? []);
	const tools = o.journal?.toolEvents() ?? [];
	const base: PackInput = {
		kind: o.kind,
		task: o.task,
		userPrompts: o.userPrompts ?? [],
		previousPlan: o.plan,
		question: o.question,
		claims: o.claims,
		reason: o.reason,
		deferred: o.deferred,
		agentsMd: readAgentsMd(o.cwd),
	};
	base.diffStat = await packDiff(exec, ["--stat"], excludes);
	if (o.kind === "review") {
		base.diff = (await packDiff(exec, [], excludes)) ?? "";
		base.changedFiles = await changedFiles(exec, o.cwd, 400, excludes);
		const lt = [...tools].reverse().find((e) => e.test);
		if (lt && o.journal) base.lastTest = verbatimCall(o.journal, lt, 8000);
	} else if (o.kind === "help") {
		base.hypothesis = o.hypothesis;
		base.attempts = o.attempts;
		if (o.journal) {
			const j = o.journal;
			const last = tools.slice(-(o.helpLastCalls ?? 8));
			base.lastCalls = last.map((e) => verbatimCall(j, e));
			const sigs = new Set(last.flatMap((e) => (e.errSig ? [e.errSig] : [])));
			const lastIds = new Set(last.map((e) => e.evt));
			base.sameErrorCalls = tools.filter((e) => e.errSig && sigs.has(e.errSig) && !lastIds.has(e.evt)).slice(-6).map((e) => verbatimCall(j, e, 3000));
			base.important = (o.importantEvts ?? []).flatMap((n) => {
				const e = j.get(n);
				return e ? [verbatimCall(j, e)] : [];
			});
			base.timeline = timelineEvents(tools.slice(-120)).filter((e) => !lastIds.has(e.evt)).slice(-60);
		}
	} else {
		base.timeline = tools.filter((e) => (e.importance ?? 0) >= 1).slice(-60);
		const files = ((await git(exec, ["ls-files"])) ?? "").split("\n").filter(Boolean).slice(0, 2000);
		base.repoMap = repoMap(files, (p) => {
			try {
				return readFileSync(join(o.cwd, p), "utf8");
			} catch {
				return undefined;
			}
		}, 16_000);
	}
	const sk = o.skills ?? {};
	if (sk.enabled !== false) {
		const all = discoverSkills(o.cwd, sk.dirs ?? SKILL_DIRS);
		if (all.length) {
			const hay = [
				o.kind,
				o.task,
				...base.userPrompts.map((p) => p.text),
				base.question ?? "",
				base.diff ?? "",
				...(base.changedFiles ?? []).map((f) => `${f.path}\n${f.content.slice(0, 4000)}`),
				base.repoMap ?? "",
				base.hypothesis ?? "",
				...(base.lastCalls ?? []).map((c) => `${c.args}\n${c.output.slice(0, 1000)}`),
			].join("\n");
			const budget = sk.budgetTokens ?? Math.floor((o.budgetTokens ?? 40_000) * 0.35);
			base.skills = selectSkills(all, hay, budget, { maxSkills: sk.maxSkills ?? 4, prefer: o.kind === "review" ? /review/i : undefined }).skills;
		}
	}
	return base;
}

export { eventLine };
