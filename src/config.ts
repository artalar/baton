import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type TranscriptMode = "facts" | "full";

export interface BatonConfig {
	/** Expensive model that plans, writes and verifies, `provider/id` in pi's model registry. */
	lead: string;
	/** Cheap model that continues the lead's tool calls during a speculative run. */
	helper: string;
	/** Speculation on or off. Off = the lead works alone (a baseline with the same harness checks). */
	speculate: boolean;
	/** Helper turns per speculative run. */
	steps: number;
	/** Wall-clock cap of one run, below the 5-minute prompt-cache TTL of the lead. */
	maxRunMs: number;
	/** Lead turns after a run before the next run may start. */
	cooldown: number;
	/** The same helper call with the same output this many times ends the run. */
	repeatLimit: number;
	/** "facts": calls, outcomes, reads verbatim, the diff, harness checks. "full": every helper output verbatim. */
	transcript: TranscriptMode;
	/** Character budgets of the run note in "facts" mode. */
	readChars: number;
	diffChars: number;
	commandTailChars: number;
	/** Hard cap of one run note, also in "full" mode. */
	noteChars: number;
	guardrails: boolean;
	checkpoints: boolean;
	checks: {
		/** Run the project's checks after a run that changed files. */
		afterRun: boolean;
		/** Run them when the lead gives its final answer; red checks send the lead back to work. */
		final: boolean;
		maxFinalRounds: number;
		timeoutMs: number;
		/** Overrides the detected typecheck, test and build commands. */
		commands?: string[];
	};
	jev: {
		enabled: boolean;
		model: string;
		fallbackModel?: string;
		timeoutMs: number;
		/** P(the lead continues with more tool calls) needed to start a run. */
		threshold: number;
		/** Recent turns of both models sent to Jev. */
		recentTurns: number;
		clipChars: number;
	};
	budget: {
		/** USD for the whole pi process, 0 = no budget. */
		usd: number;
		/** Multiplier on the helper's reported cost. */
		helperCostFactor: number;
		/** Minimum USD kept for the lead's wrap-up; the real reserve also covers the largest lead turn seen. */
		reserveUsd: number;
	};
	journalDir: string;
}

export const DEFAULT_CONFIG: BatonConfig = {
	lead: "openrouter/anthropic/claude-opus-5.5",
	helper: "openrouter/z-ai/glm-5.3-flash",
	speculate: true,
	steps: 6,
	maxRunMs: 150_000,
	cooldown: 1,
	repeatLimit: 3,
	transcript: "facts",
	readChars: 40_000,
	diffChars: 16_000,
	commandTailChars: 1_500,
	noteChars: 120_000,
	guardrails: true,
	checkpoints: true,
	checks: { afterRun: true, final: true, maxFinalRounds: 2, timeoutMs: 120_000 },
	jev: { enabled: true, model: "typesafe/jev-1.13", fallbackModel: "microsoft/microsoft-decision-1", timeoutMs: 800, threshold: 0.8, recentTurns: 4, clipChars: 220 },
	budget: { usd: 0, helperCostFactor: 1, reserveUsd: 0.25 },
	journalDir: ".pi/baton",
};

/** Keys a project `.pi/baton.json` may not set: they choose models, spend money, or write files. */
const USER_ONLY_KEYS = ["lead", "helper", "budget", "journalDir"] as const;
const USER_ONLY_JEV_KEYS = ["model", "fallbackModel"] as const;

const ENV_ON = new Set(["1", "on", "true", "yes"]);
const ENV_OFF = new Set(["0", "off", "false", "no"]);

export function envFlag(name: string, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
	const value = env[name]?.trim().toLowerCase();
	if (!value) return undefined;
	if (ENV_ON.has(value)) return true;
	if (ENV_OFF.has(value)) return false;
	return undefined;
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/** The same model across a provider prefix (`openrouter/anthropic/x` and `anthropic/x`). */
export function isSameModel(model: string | undefined, ref: string | undefined): boolean {
	if (!model || !ref) return false;
	const withoutRouter = (value: string) => (value.startsWith("openrouter/") ? value.slice("openrouter/".length) : value);
	return withoutRouter(model) === withoutRouter(ref);
}

export function isInside(cwd: string, path: string): boolean {
	const relativePath = relative(resolve(cwd), resolve(cwd, path));
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function deepMerge<T>(base: T, override: unknown): T {
	if (override === undefined || override === null) return base;
	if (!isRecord(base) || !isRecord(override)) return override as T;
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) merged[key] = isRecord(merged[key]) && isRecord(value) ? deepMerge(merged[key], value) : value;
	return merged as T;
}

function readConfigFile(path: string, warn: (message: string) => void): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : undefined;
	} catch (error) {
		warn(`baton: cannot parse ${path}: ${(error as Error).message}`);
		return undefined;
	}
}

function withoutUserOnlyKeys(projectConfig: Record<string, unknown>, userConfigPath: string, warn: (message: string) => void): Record<string, unknown> {
	const allowed = { ...projectConfig };
	for (const key of USER_ONLY_KEYS) {
		if (!(key in allowed)) continue;
		warn(`baton: ignoring ${key} from the project .pi/baton.json (set it in ${userConfigPath} or the environment)`);
		delete allowed[key];
	}
	if (isRecord(allowed.jev)) {
		const jev = { ...allowed.jev };
		for (const key of USER_ONLY_JEV_KEYS) {
			if (!(key in jev)) continue;
			warn(`baton: ignoring jev.${key} from the project .pi/baton.json (set it in ${userConfigPath} or the environment)`);
			delete jev[key];
		}
		allowed.jev = jev;
	}
	return allowed;
}

function positiveNumber(name: string, env: NodeJS.ProcessEnv, warn: (message: string) => void): number | undefined {
	const raw = env[name]?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	if (Number.isFinite(value) && value > 0) return value;
	warn(`baton: ${name}=${raw} is not a positive number; ignoring it`);
	return undefined;
}

/** User file `~/.pi/agent/baton.json`, then the project `.pi/baton.json`, then environment variables. */
export function loadConfig(cwd: string, warn: (message: string) => void = () => {}, env: NodeJS.ProcessEnv = process.env): BatonConfig {
	const userConfigPath = join(agentDir(env), "baton.json");
	const projectConfig = readConfigFile(join(cwd, ".pi", "baton.json"), warn);
	let config = deepMerge(DEFAULT_CONFIG, readConfigFile(userConfigPath, warn));
	if (projectConfig) config = deepMerge(config, withoutUserOnlyKeys(projectConfig, userConfigPath, warn));
	config = { ...config, checks: { ...config.checks }, jev: { ...config.jev }, budget: { ...config.budget } };

	if (env.BATON_LEAD) config.lead = env.BATON_LEAD;
	if (env.BATON_HELPER) config.helper = env.BATON_HELPER;
	const speculate = envFlag("BATON_SPEC", env);
	if (speculate !== undefined) config.speculate = speculate;
	const steps = positiveNumber("BATON_STEPS", env, warn);
	if (steps) config.steps = Math.round(steps);
	const transcript = env.BATON_TRANSCRIPT?.trim().toLowerCase();
	if (transcript === "full" || transcript === "facts") config.transcript = transcript;
	else if (transcript) warn(`baton: BATON_TRANSCRIPT must be "facts" or "full"; ignoring ${transcript}`);
	const checks = envFlag("BATON_CHECKS", env);
	if (checks !== undefined) config.checks = { ...config.checks, afterRun: checks, final: checks };
	const jev = envFlag("BATON_JEV", env);
	if (jev !== undefined) config.jev.enabled = jev;
	if (env.BATON_JEV_MODEL) config.jev.model = env.BATON_JEV_MODEL;
	if (env.BATON_JEV_FALLBACK_MODEL) config.jev.fallbackModel = env.BATON_JEV_FALLBACK_MODEL;
	const budget = positiveNumber("BATON_BUDGET_USD", env, warn);
	if (budget) config.budget.usd = budget;
	if (env.BATON_JOURNAL_DIR) config.journalDir = env.BATON_JOURNAL_DIR;

	if (!isInside(cwd, config.journalDir)) {
		warn(`baton: journalDir ${config.journalDir} is outside the working directory; using ${DEFAULT_CONFIG.journalDir}`);
		config.journalDir = DEFAULT_CONFIG.journalDir;
	}
	if (!parseModelRef(config.lead)) warn(`baton: lead model "${config.lead}" is not provider/id`);
	if (!parseModelRef(config.helper)) warn(`baton: helper model "${config.helper}" is not provider/id`);
	return config;
}
