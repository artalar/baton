#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const piBin = resolve(repoRoot, "node_modules/.bin/pi");
const budgetExt = resolve(here, "budget-extension.js");
const bashTimeoutExt = resolve(here, "bash-timeout-extension.js");
const flashAgent = resolve(here, "agents/flash.md");
const require = createRequire(import.meta.url);

/** OpenRouter refuses a request unless the key can pay for max_tokens of output: 128k Opus tokens at $20/M, plus the prompt. */
const LARGEST_LEAD_REQUEST_USD = 2.6;
const leadTools = "read,bash,edit,write,grep,find,ls";

const args = parseArgs(process.argv.slice(2));
if (args.help === true) {
	console.log(`usage: bun evals/reatom-2048/harness/run.mjs --name <name> [options]

--cwd             workspace directory (default: tmp/<name>)
--prompt          prompt file (default: tmp/prompt.txt)
--budget          max USD (default: 3; pass 2 for the 2048 eval)
--session-name    new pi session name (default: <name>)
--baton           0 runs without the Baton extension (default: on)
--baton-ext       Baton build to load (default: dist/index.js of this repo)
--delegate        1 lets the lead call the flash agent (default: 0)
--minutes         wall-clock limit (default: 20)
--prior-usd       cost already spent, added to the budget check
--session         resume an existing pi session id
--message         follow-up prompt instead of the prompt file
--skip-preflight  start even if the OpenRouter key cannot cover the budget`);
	process.exit(0);
}

const name = required(args.name, "--name");
const cwd = resolve(args.cwd ?? resolve(repoRoot, "tmp", name));
const withBaton = args.baton !== "0" && args.baton !== false;
const delegate = flag01(args.delegate, "--delegate");
const budgetUsd = Number(args.budget ?? 3);
const priorUsd = Number(args["prior-usd"] ?? 0);
const limitMs = Number(args.minutes ?? 20) * 60 * 1000;
const session = typeof args.session === "string" ? args.session : undefined;
const sessionName = typeof args["session-name"] === "string" ? args["session-name"] : name;
const followup = typeof args.message === "string" ? args.message : undefined;
const promptPath = typeof args.prompt === "string" ? resolve(args.prompt) : resolve(repoRoot, "tmp/prompt.txt");
const batonExt = typeof args["baton-ext"] === "string" ? resolve(args["baton-ext"]) : resolve(repoRoot, "dist/index.js");
const batonBuild = withBaton ? describeBuild(batonExt) : undefined;
const subagentExt = delegate ? subagentExtensionPath() : undefined;
const prompt = readPrompt(promptPath);
const apiKey = readApiKey(resolve(repoRoot, ".env"));
const credit = await readOpenRouterCredit(apiKey);
const requiredUsd = Math.max(budgetUsd - priorUsd, 0) + LARGEST_LEAD_REQUEST_USD;
if (credit.remainingUsd !== undefined && credit.remainingUsd < requiredUsd && args["skip-preflight"] !== true) {
	console.error(`OpenRouter key has $${credit.remainingUsd.toFixed(2)} left; this run needs about $${requiredUsd.toFixed(2)} (budget plus one ${LARGEST_LEAD_REQUEST_USD} USD lead request). Top up or pass --skip-preflight.`);
	process.exit(2);
}
if (credit.error) console.warn(`OpenRouter credit check skipped: ${credit.error}`);

const logsDir = resolve(cwd, ".run");
mkdirSync(logsDir, { recursive: true });
const eventsPath = resolve(logsDir, session ? "events-continue.jsonl" : "events.jsonl");
const stderrPath = resolve(logsDir, session ? "stderr-continue.log" : "stderr.log");
const statusPath = resolve(logsDir, "status.json");
writeFileSync(eventsPath, "");
writeFileSync(stderrPath, "");
if (delegate) installFlashAgent(cwd);

const piArgs = [
	"--print",
	"--mode",
	"json",
	"--no-extensions",
	"--no-mcp",
	"--approve",
	"--session-dir",
	resolve(cwd, ".pi/sessions"),
	"--tools",
	delegate ? `${leadTools},subagent` : leadTools,
	"--model",
	"openrouter/anthropic/claude-opus-5.5",
	"--thinking",
	"medium",
	"--extension",
	budgetExt,
	"--extension",
	bashTimeoutExt,
];
if (subagentExt) piArgs.push("--extension", subagentExt);
if (session) piArgs.push("--session", session);
else piArgs.push("--name", sessionName);
if (withBaton) piArgs.push("--extension", batonExt);
piArgs.push("--", followup ?? prompt);

const env = {
	...process.env,
	OPENROUTER_API_KEY: apiKey,
	API_KEY: apiKey,
	PI_CODING_AGENT_DIR: resolve(cwd, ".pi-agent"),
	PI_CODING_AGENT_SESSION_DIR: resolve(cwd, ".pi/sessions"),
	PI_CACHE_RETENTION: "long",
	RUN_BUDGET_USD: String(budgetUsd),
	RUN_LIMIT_MS: String(limitMs),
};
if (withBaton) env.BATON_SPEC = "1";
else env.BATON_SPEC = "0";

const startedAt = Date.now();
const costs = {};
let totalUsd = priorUsd;
let lastEvent = "";
let stopReason = "";
let settled = false;
let child;
let lastAssistant;
const requestErrors = [];

writeStatus("starting");

child = spawn(piBin, piArgs, {
	cwd,
	env,
	stdio: ["ignore", "pipe", "pipe"],
});

writeStatus("running", { pid: child.pid });

let stdoutBuf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	stdoutBuf += chunk;
	let nl;
	while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
		const line = stdoutBuf.slice(0, nl).replace(/\r$/, "");
		stdoutBuf = stdoutBuf.slice(nl + 1);
		if (!line.trim()) continue;
		appendFileSync(eventsPath, `${line}\n`);
		handleEvent(line);
	}
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	appendFileSync(stderrPath, chunk);
});

const watchdog = setInterval(() => {
	if (stopReason) return;
	const elapsed = Date.now() - startedAt;
	if (totalUsd >= budgetUsd) requestStop(`budget $${totalUsd.toFixed(3)} >= $${budgetUsd}`);
	else if (elapsed >= limitMs) requestStop(`time ${Math.round(elapsed / 1000)}s >= ${Math.round(limitMs / 1000)}s`);
	else writeStatus("running");
}, 2000);

child.on("exit", (code, signal) => {
	clearInterval(watchdog);
	if (stdoutBuf.trim()) {
		appendFileSync(eventsPath, `${stdoutBuf}\n`);
		handleEvent(stdoutBuf);
	}
	const finalRequestFailed = lastAssistant?.stopReason === "error";
	const exitReason = stopReason || (finalRequestFailed ? `final request failed: ${lastAssistant.errorMessage}` : code === 0 ? "completed" : `exit ${code}`);
	writeStatus("exited", { exitCode: code, signal, stopReason: exitReason, finalRequestFailed, settled });
	process.exitCode = (code === 0 || stopReason) && !finalRequestFailed ? 0 : 1;
});

function handleEvent(line) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	lastEvent = event.type ?? "";
	if (event.type === "message_end" && event.message?.role === "assistant") {
		const model = event.message.model ?? "unknown";
		const usage = event.message.usage ?? {};
		const usd = Number(usage.cost?.total ?? 0);
		const row = costs[model] ?? { requests: 0, usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		row.requests += 1;
		row.usd += usd;
		row.input += Number(usage.input ?? 0);
		row.output += Number(usage.output ?? 0);
		row.cacheRead += Number(usage.cacheRead ?? 0);
		row.cacheWrite += Number(usage.cacheWrite ?? 0);
		costs[model] = row;
		totalUsd = priorUsd + Object.values(costs).reduce((sum, item) => sum + item.usd, 0);
		const errorMessage = oneLine(event.message.errorMessage ?? "");
		lastAssistant = { model, stopReason: event.message.stopReason, errorMessage };
		if (event.message.stopReason === "error") requestErrors.push({ model, errorMessage });
		if (totalUsd >= budgetUsd) requestStop(`budget $${totalUsd.toFixed(3)} >= $${budgetUsd}`);
	}
	if (event.type === "agent_settled") settled = true;
	writeStatus("running");
}

function requestStop(reason) {
	if (stopReason) return;
	stopReason = reason;
	writeStatus("stopping");
	child.kill("SIGTERM");
	setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, 8000);
}

function writeStatus(state, extra = {}) {
	const payload = {
		name,
		sessionName,
		promptPath,
		withBaton,
		delegate,
		batonBuild,
		creditBeforeUsd: credit.remainingUsd,
		state,
		pid: child?.pid,
		elapsedSec: Math.round((Date.now() - startedAt) / 1000),
		limitSec: Math.round(limitMs / 1000),
		budgetUsd,
		totalUsd: Number(totalUsd.toFixed(4)),
		costs,
		lastEvent,
		stopReason: stopReason || null,
		requestErrors,
		cwd,
		...extra,
	};
	writeFileSync(statusPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function oneLine(text) {
	return String(text).replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Remaining USD on the key: the lower of its own limit and the account balance, when OpenRouter reports them. */
async function readOpenRouterCredit(key) {
	const headers = { Authorization: `Bearer ${key}` };
	const readJson = async (path) => {
		const response = await fetch(`https://openrouter.ai/api/v1/${path}`, { headers, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
		return (await response.json()).data ?? {};
	};
	try {
		const [keyInfo, credits] = await Promise.all([readJson("key"), readJson("credits").catch(() => ({}))]);
		const keyRemaining = typeof keyInfo.limit_remaining === "number" ? keyInfo.limit_remaining : undefined;
		const accountRemaining = typeof credits.total_credits === "number" && typeof credits.total_usage === "number" ? credits.total_credits - credits.total_usage : undefined;
		const known = [keyRemaining, accountRemaining].filter((value) => value !== undefined);
		return { remainingUsd: known.length ? Math.min(...known) : undefined };
	} catch (error) {
		return { remainingUsd: undefined, error: error instanceof Error ? error.message : String(error) };
	}
}

function describeBuild(extensionPath) {
	const dir = dirname(extensionPath);
	const git = (...gitArgs) => spawnSync("git", ["-C", dir, ...gitArgs], { encoding: "utf8" }).stdout?.trim() ?? "";
	return { path: extensionPath, commit: git("rev-parse", "--short", "HEAD") || undefined, dirty: git("status", "--porcelain", "--", ":/src").length > 0 };
}

function subagentExtensionPath() {
	let packageJson;
	try {
		packageJson = require.resolve("@earendil-works/pi-coding-agent/package.json");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`cannot resolve @earendil-works/pi-coding-agent: ${message}`);
		process.exit(2);
	}
	const extension = resolve(dirname(packageJson), "examples/extensions/subagent/index.ts");
	if (!existsSync(extension)) {
		console.error(`pi subagent example not found: ${extension}`);
		process.exit(2);
	}
	return extension;
}

function installFlashAgent(workspace) {
	const agentsDir = resolve(workspace, ".pi-agent/agents");
	mkdirSync(agentsDir, { recursive: true });
	copyFileSync(flashAgent, resolve(agentsDir, "flash.md"));
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) out[key] = true;
		else {
			out[key] = next;
			i++;
		}
	}
	return out;
}

function flag01(value, flag) {
	if (value === undefined || value === "0" || value === false) return false;
	if (value === "1" || value === true) return true;
	console.error(`${flag} must be 0 or 1`);
	process.exit(2);
}

function required(value, flag) {
	if (!value || value === true) {
		console.error(`missing ${flag}`);
		process.exit(2);
	}
	return value;
}

function readPrompt(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`cannot read prompt ${path}: ${message}`);
		process.exit(2);
	}
	const prompt = text.trim();
	if (!prompt) {
		console.error(`prompt is empty: ${path}`);
		process.exit(2);
	}
	return prompt;
}

function readApiKey(path) {
	const fromEnv = process.env.OPENROUTER_API_KEY;
	if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : "";
		if (code === "ENOENT") {
			console.error("OPENROUTER_API_KEY is not set, and .env was not found");
			process.exit(2);
		}
		const message = error instanceof Error ? error.message : String(error);
		console.error(`cannot read .env: ${message}`);
		process.exit(2);
	}
	const match = text.match(/^\s*API_KEY\s*=\s*(\S+)/m);
	if (!match) {
		console.error("OPENROUTER_API_KEY is not set, and API_KEY was not found in .env");
		process.exit(2);
	}
	return match[1];
}
