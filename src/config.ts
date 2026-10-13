import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TriggerConfig {
	/** Nudge when context usage reaches this fraction of the window. */
	contextRatio: number;
	/** Nudge baton_help when the same error signature is seen this many times. */
	sameErrorCount: number;
	/** Block `git commit` until a baton_review returned verdict on_track/done. */
	reviewBeforeCommit: boolean;
	/** Remind the executor after this many tool calls without an advisor call (0 = off). */
	remindEvery: number;
	/** Minimum tool calls between two automatic nudges (cooldown). */
	minGapCalls: number;
}

export interface JudgeConfig {
	enabled: boolean;
	/** "provider/id" of a classifier model, e.g. typesafe/jev-latest. */
	model: string;
	minConfidence: number;
}

export interface BatonConfig {
	/** Informational: the intended executor model ("provider/id"). Baton does not switch models. */
	executor: string;
	/** Advisor model ("provider/id"), called once per baton_review/help/plan. */
	advisor: string;
	advisorMaxTokens: number;
	judge: JudgeConfig;
	packBudgetTokens: number;
	triggers: TriggerConfig;
	mask: {
		enabled: boolean;
		/** Tool names whose output is never masked. */
		exemptTools: string[];
		dedupReads: boolean;
		staleReads: boolean;
	};
	help: { lastCalls: number };
	reset: { keepTurns: number };
	/** Replace pi's LLM auto-compaction (threshold/overflow) with Baton's deterministic summary. */
	replaceAutoCompact: boolean;
	journalDir: string;
}

export const DEFAULT_CONFIG: BatonConfig = {
	executor: "openrouter/z-ai/glm-5.3-flash",
	advisor: "openrouter/anthropic/claude-opus-5.5",
	advisorMaxTokens: 4096,
	judge: { enabled: false, model: "typesafe/jev-latest", minConfidence: 0.7 },
	packBudgetTokens: 40_000,
	triggers: { contextRatio: 0.6, sameErrorCount: 3, reviewBeforeCommit: true, remindEvery: 25, minGapCalls: 5 },
	mask: {
		enabled: true,
		exemptTools: ["baton_review", "baton_help", "baton_plan"],
		dedupReads: true,
		staleReads: true,
	},
	help: { lastCalls: 8 },
	reset: { keepTurns: 2 },
	replaceAutoCompact: true,
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
