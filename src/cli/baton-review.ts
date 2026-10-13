#!/usr/bin/env node
/**
 * baton-review: build the pack and call the advisor through OpenRouter (env OPENROUTER_API_KEY only).
 *   baton-review [--model anthropic/claude-opus-5.5] [--max-tokens N] [--no-cache] [baton-pack options] TASK...
 * Prints the validated JSON reply; exit 1 when the advisor call failed.
 */
import { runAdvisor } from "../core/advisor.ts";
import { openRouterComplete, openRouterModelId } from "../core/openrouter.ts";
import { renderPlan } from "../core/schema.ts";
import { packFromArgs, parseArgs } from "./baton-pack.ts";

export const DEFAULT_REVIEW_MODEL = "anthropic/claude-opus-5.5";

export async function main() {
	const a = parseArgs(process.argv.slice(2));
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
