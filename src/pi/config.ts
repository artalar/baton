import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReviewGateConfig } from "./gate.ts";
import type { LoopConfig } from "./loop.ts";

export interface TriggerConfig {
	/** At this fraction of the context window, force a handoff (auto baton_review + reset); a nudge in continuous mode. */
	contextRatio: number;
	/** Nudge baton_help when the same error signature is seen this many times. */
	sameErrorCount: number;
	/** Block `git commit` until a baton_review returned verdict on_track/done. */
	reviewBeforeCommit: boolean;
	/** Remind the executor after this many tool calls without an advisor call (0 = off). */
	remindEvery: number;
	/** Minimum tool calls between two automatic nudges (cooldown). */
	minGapCalls: number;
	/** Nudge baton_review at the first milestone (first green test run or successful build after edits). */
	milestoneReview: boolean;
	/** Nudge baton_plan after this many exploration (read-only) calls without a plan (0 = off). */
	autoPlanAfterReads: number;
	/** Block the first write/edit once (soft gate) until baton_plan was called. Retrying the write passes. */
	planBeforeWrite: boolean;
	/** With a plan pinned: nudge after this many tool calls without baton_step (0 = off). */
	driftCalls: number;
}

export interface BatonConfig {
	/** The expensive reviewer, called once per baton_review/help/plan. */
	advisor: {
		/** "provider/id" in pi's model registry. */
		model: string;
		maxTokens: number;
		/** Prompt caching of the stable prefix (role + skills + AGENTS.md): "short" (5 min), "long" (1 h), "none". */
		cache: "short" | "long" | "none";
		/** 0.11: refresh the cached shared system prefix while a next advisor call is expected (everyMs 0 = off). */
		keepalive: { everyMs: number; max: number };
	};
	/** Context preparation for the advisor. */
	pack: {
		budgetTokens: number;
		/** Globs never included in the pack diff / changed files (in addition to journalDir), regardless of .gitignore. */
		excludePaths: string[];
		/** Include relevant project skills (SKILL.md) in advisor packs. */
		skills: { enabled: boolean; budgetRatio: number; maxSkills: number; dirs: string[] };
		/** Pin the latest advisor plan into every executor request. */
		pinPlan: boolean;
		/** baton_help: how many last tool calls go to the advisor verbatim. */
		helpLastCalls: number;
	};
	/** Review gating and finalize mode (see src/pi/gate.ts). */
	review: ReviewGateConfig;
	/** Nudges and soft gates (plan before write, review before commit, context pressure). */
	triggers: TriggerConfig;
	/** Deterministic stuck-loop detector (see src/pi/loop.ts). */
	loop: LoopConfig;
	/**
	 * OPTIONAL executor-context compaction at handoffs (v0.4 behaviour). Off by default: the advisor reply is
	 * appended to the conversation normally and nothing is masked or cut.
	 */
	compact: {
		enabled: boolean;
		/** Assistant turns kept after a reset. */
		keepTurns: number;
		/** Tool outputs kept verbatim after a review/plan handoff (help keeps pack.helpLastCalls). */
		keepCalls: number;
		/** Tool names whose output is never stubbed. */
		exemptTools: string[];
		/** Reads matching these globs are never stubbed: skills and reference docs. */
		neverMaskPaths: string[];
		/** Route pi's auto-compaction through a review handoff and Baton's deterministic summary. */
		replaceAutoCompact: boolean;
	};
	journalDir: string;
}

export const DEFAULT_CONFIG: BatonConfig = {
	advisor: { model: "openrouter/anthropic/claude-opus-5.5", maxTokens: 8192, cache: "short", keepalive: { everyMs: 240_000, max: 5 } },
	pack: {
		budgetTokens: 40_000,
		excludePaths: [
			".pi/baton/**",
			"**/node_modules/**",
			"**/dist/**",
			"**/package-lock.json",
			"**/npm-shrinkwrap.json",
			"**/pnpm-lock.yaml",
			"**/yarn.lock",
			"**/bun.lock",
			"**/bun.lockb",
			"**/Cargo.lock",
			"**/poetry.lock",
			"**/uv.lock",
			"**/go.sum",
			"**/composer.lock",
			"**/Gemfile.lock",
		],
		skills: { enabled: true, budgetRatio: 0.35, maxSkills: 4, dirs: [".agents/skills", ".pi/skills", ".claude/skills", "skills"] },
		pinPlan: true,
		helpLastCalls: 8,
	},
	// C4: 8 handoffs, 3 of them ping-pong reviews 5-11 calls apart; these refuse exactly those.
	review: { enabled: true, minDiffLines: 80, minCalls: 15, helpMinCalls: 5, finalizeAfterDone: true },
	triggers: {
		contextRatio: 0.6,
		sameErrorCount: 3,
		reviewBeforeCommit: true,
		remindEvery: 12,
		minGapCalls: 5,
		milestoneReview: true,
		autoPlanAfterReads: 8,
		planBeforeWrite: true,
		driftCalls: 20,
	},
	// Calibrated on experiment C v2: fires at call 324 (8 edit→run→fail hops on the lock-delay test,
	// 21 calls after its first failure); max hop count on any signature before that loop: 1.
	loop: {
		enabled: true,
		windowCalls: 30,
		maxHops: 6,
		hopGapCalls: 30,
		readRepeatThreshold: 8,
		action: "help",
		blockDeferredEdits: true,
		ignoreReadPaths: ["**/node_modules/**", "**/SKILL.md", "**/REFERENCE.md", "**/README.md", "**/AGENTS.md", ".agents/**", ".pi/**", "docs/**"],
	},
	compact: {
		enabled: false,
		keepTurns: 2,
		keepCalls: 2,
		exemptTools: ["baton_review", "baton_help", "baton_plan", "baton_step"],
		neverMaskPaths: [
			"**/SKILL.md",
			".agents/skills/**",
			".pi/skills/**",
			".claude/skills/**",
			"skills/**/*.md",
			"**/AGENTS.md",
			"**/CLAUDE.md",
			"**/README.md",
			"**/REFERENCE.md",
			"docs/**/*.md",
		],
		replaceAutoCompact: true,
	},
	journalDir: ".pi/baton",
};

const SECRET_KEY = /(api[_-]?key|token|secret|password)/i;

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, over: unknown): T {
	if (!isObj(over) || !isObj(base)) return base;
	const out: Json = { ...(base as Json) };
	for (const [k, v] of Object.entries(over)) {
		if (SECRET_KEY.test(k)) continue; // never accept keys in Baton config
		const cur = out[k];
		out[k] = isObj(cur) && isObj(v) ? deepMerge(cur, v) : v;
	}
	return out as T;
}

export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
	const i = ref.indexOf("/");
	if (i <= 0 || i === ref.length - 1) return undefined;
	return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

function readJson(path: string, warn: (m: string) => void): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		warn(`baton: cannot parse ${path}: ${(e as Error).message}`);
		return undefined;
	}
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Global ~/.pi/agent/baton.json, then project .pi/baton.json. */
export function loadConfig(cwd: string, warn: (m: string) => void = () => {}): BatonConfig {
	let cfg = DEFAULT_CONFIG;
	cfg = deepMerge(cfg, readJson(join(agentDir(), "baton.json"), warn));
	cfg = deepMerge(cfg, readJson(join(cwd, ".pi", "baton.json"), warn));
	return cfg;
}

/**
 * Pure: is keeping the advisor cache warm worth it? Anthropic prices (× base input): cache write 1.25,
 * cache read 0.1. Without keepalive the next call rewrites the prefix (1.25·S, from the 2nd call on);
 * with it, k pings read it (k·0.1·S) and the call reads it too (0.1·S). With probability p that the
 * next call happens: worth it iff k·0.1 < p·(1.25 − 0.1), i.e. k < 11.5·p. Ping every 4 min → for
 * p = 1 it pays for gaps up to ~46 min; for p = 0.5 up to ~23 min. Default max 5 pings (20 min).
 */
export function advisorKeepaliveWorthIt(pings: number, pNextCall: number): boolean {
	return pings * 0.1 < pNextCall * (1.25 - 0.1);
}
