import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface BatonConfig {
	/** Expensive model that owns the task, `provider/id` in pi's model registry. */
	lead: string;
	/** Cheap model that continues the lead's work during a speculative run. */
	helper: string;
	/** Thinking level of the helper during a run; "inherit" keeps the lead's level. */
	helperThinking: HelperThinking;
	/** Speculation on or off. Off = the lead works alone. */
	speculate: boolean;
	/** Safety cap of follower turns per later run; the first run uses FIRST_RUN_MAX_TURNS. */
	maxHelperTurns: number;
	/** While a run is active, the lead's last request is re-sent this long after it was sent, and again after each re-send, so its prompt cache does not expire. 0 = off. */
	cacheKeepaliveMs: number;
	journalDir: string;
}

export const FIRST_RUN_MAX_TURNS = 5;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type HelperThinking = ThinkingLevel | "inherit";

const isHelperThinking = (value: unknown): value is HelperThinking => value === "inherit" || (THINKING_LEVELS as readonly unknown[]).includes(value);

export const DEFAULT_CONFIG: BatonConfig = {
	lead: "openrouter/anthropic/claude-opus-5.5",
	helper: "openrouter/z-ai/glm-5.3-flash",
	helperThinking: "low",
	speculate: true,
	maxHelperTurns: 10,
	cacheKeepaliveMs: 290_000,
	journalDir: ".pi/baton",
};

/** A project file may set cacheKeepaliveMs, and every keepalive is billed as a cache read of the whole lead prompt. One hour is the longest prompt cache tier. */
const CACHE_KEEPALIVE_MIN_MS = 60_000;
const CACHE_KEEPALIVE_MAX_MS = 3_600_000;

function isCacheKeepaliveMs(value: unknown): boolean {
	if (value === 0) return true;
	return typeof value === "number" && Number.isInteger(value) && value >= CACHE_KEEPALIVE_MIN_MS && value <= CACHE_KEEPALIVE_MAX_MS;
}

/** Keys a project `.pi/baton.json` may not set: they choose models (and so spend money) or write files. */
const USER_ONLY_KEYS = ["lead", "helper", "journalDir"] as const;

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

/** Same model, or one name with a single leading `provider/` segment (`anthropic/claude-haiku` and `claude-haiku`, `openrouter/anthropic/x` and `anthropic/x`). */
export function isSameModel(model: string | undefined, ref: string | undefined): boolean {
	if (!model || !ref) return false;
	if (model === ref) return true;
	const idAfterProvider = (value: string) => {
		const slash = value.indexOf("/");
		return slash > 0 ? value.slice(slash + 1) : undefined;
	};
	return idAfterProvider(model) === ref || idAfterProvider(ref) === model;
}

export function isInside(cwd: string, path: string): boolean {
	const relativePath = relative(resolve(cwd), resolve(cwd, path));
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

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
	return allowed;
}

function envInteger(name: string, minimum: number, env: NodeJS.ProcessEnv, warn: (message: string) => void): number | undefined {
	const raw = env[name]?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	if (Number.isInteger(value) && value >= minimum) return value;
	warn(`baton: ${name}=${raw} is not ${minimum > 0 ? "a positive" : "a non-negative"} integer; ignoring it`);
	return undefined;
}

/** User file `~/.pi/agent/baton.json`, then the project `.pi/baton.json`, then environment variables. */
export function loadConfig(cwd: string, warn: (message: string) => void = () => {}, env: NodeJS.ProcessEnv = process.env): BatonConfig {
	const userConfigPath = join(agentDir(env), "baton.json");
	const userConfig = readConfigFile(userConfigPath, warn) ?? {};
	const projectConfig = readConfigFile(join(cwd, ".pi", "baton.json"), warn) ?? {};
	const config: BatonConfig = { ...DEFAULT_CONFIG, ...userConfig, ...withoutUserOnlyKeys(projectConfig, userConfigPath, warn) };

	if (env.BATON_LEAD) config.lead = env.BATON_LEAD;
	if (env.BATON_HELPER) config.helper = env.BATON_HELPER;
	if (env.BATON_HELPER_THINKING) config.helperThinking = env.BATON_HELPER_THINKING.trim().toLowerCase() as HelperThinking;
	const speculate = envFlag("BATON_SPEC", env);
	if (speculate !== undefined) config.speculate = speculate;
	const maxHelperTurns = envInteger("BATON_MAX_TURNS", 1, env, warn);
	if (maxHelperTurns) config.maxHelperTurns = maxHelperTurns;
	const cacheKeepaliveMs = envInteger("BATON_CACHE_KEEPALIVE_MS", 0, env, warn);
	if (cacheKeepaliveMs !== undefined) config.cacheKeepaliveMs = cacheKeepaliveMs;
	if (env.BATON_JOURNAL_DIR) config.journalDir = env.BATON_JOURNAL_DIR;

	if (!isCacheKeepaliveMs(config.cacheKeepaliveMs)) {
		warn(`baton: cacheKeepaliveMs ${JSON.stringify(config.cacheKeepaliveMs)} is neither 0 (off) nor ${CACHE_KEEPALIVE_MIN_MS}–${CACHE_KEEPALIVE_MAX_MS}; using ${DEFAULT_CONFIG.cacheKeepaliveMs}`);
		config.cacheKeepaliveMs = DEFAULT_CONFIG.cacheKeepaliveMs;
	}
	if (!isHelperThinking(config.helperThinking)) {
		warn(`baton: helperThinking ${JSON.stringify(config.helperThinking)} is none of inherit, ${THINKING_LEVELS.join(", ")}; using ${DEFAULT_CONFIG.helperThinking}`);
		config.helperThinking = DEFAULT_CONFIG.helperThinking;
	}
	if (!isInside(cwd, config.journalDir)) {
		warn(`baton: journalDir ${config.journalDir} is outside the working directory; using ${DEFAULT_CONFIG.journalDir}`);
		config.journalDir = DEFAULT_CONFIG.journalDir;
	}
	if (!parseModelRef(config.lead)) warn(`baton: lead model "${config.lead}" is not provider/id`);
	if (!parseModelRef(config.helper)) warn(`baton: helper model "${config.helper}" is not provider/id`);
	if (config.speculate && isSameModel(config.lead, config.helper)) {
		warn("baton: lead and helper are the same model; speculation is off");
		config.speculate = false;
	}
	return config;
}
