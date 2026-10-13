#!/usr/bin/env node
/**
 * baton-review: build the pack and call the advisor through OpenRouter (env OPENROUTER_API_KEY only).
 *   baton-review [--model anthropic/claude-opus-5.5] [--max-tokens N] [--no-cache] [baton-pack options] TASK...
 * Prints the validated JSON reply; exit 1 when the advisor call failed.
 */
import { runAdvisor } from "../core/advisor.ts";
import { openRouterComplete, openRouterModelId } from "../core/openrouter.ts";
import { renderPlan } from "../core/schema.ts";
import { packageVersion, packFromArgs, parseArgs } from "./baton-pack.ts";

export const DEFAULT_REVIEW_MODEL = "anthropic/claude-opus-5.5";

export function reviewUsage(): string {
	return [
		"baton-review: build the pack and call the advisor through OpenRouter (OPENROUTER_API_KEY).",
		"Usage: baton-review [options] TASK...",
		"",
		"Options:",
		"  --model MODEL          advisor model (default anthropic/claude-opus-5.5)",
		"  --max-tokens N         output token limit (positive integer)",
		"  --no-cache             disable prompt caching",
		"  --cwd DIR              repository directory (default: cwd)",
		"  --kind review|help|plan",
		"  --plan FILE            pinned plan file",
		"  --claim TEXT           executor claim (repeatable)",
		"  --budget N             pack budget in tokens (positive integer)",
		"  --json                 print the validated reply as JSON",
		"  --task-file FILE       read the task from a file",
		"  -h, --help             show this help",
		"  -V, --version          print the package version",
		"",
	].join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)) {
	const parsed = parseArgs(argv);
	if ("help" in parsed) {
		process.stdout.write(reviewUsage());
		return;
	}
	if ("version" in parsed) {
		process.stdout.write(`${packageVersion()}\n`);
		return;
	}
	const a = parsed;
	if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
	const pack = await packFromArgs(a);
	const model = openRouterModelId(a.model ?? DEFAULT_REVIEW_MODEL);
	process.stderr.write(`baton-review: ${model}, pack ~${pack.tokens} tokens (stable prefix ~${pack.stableTokens})\n`);
	const res = await runAdvisor(model, pack.messages, openRouterComplete({ model, maxTokens: a.maxTokens, cache: !a.noCache }));
	if (!res.ok || !res.reply) {
		process.stderr.write(`baton-review: advisor failed: ${(res.errors ?? ["unknown"]).join("; ")}\n`);
		if (res.raw) process.stdout.write(`${res.raw}\n`);
		process.exit(1);
	}
	process.stdout.write(a.json ? `${JSON.stringify({ reply: res.reply, usage: res.usage }, null, 2)}\n` : `${renderPlan(res.reply, "baton-review", res.truncated)}\n`);
}

/** Entry point used by bin/baton-review.mjs. */
export function run(): void {
	main().catch((e) => {
		process.stderr.write(`baton-review: ${(e as Error).message}\n`);
		process.exit(2);
	});
}
