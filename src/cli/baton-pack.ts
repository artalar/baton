#!/usr/bin/env node
/**
 * baton-pack: print the advisor pack for a repository + task. No LLM call.
 *   baton-pack [--cwd DIR] [--kind review|help|plan] [--plan FILE] [--claim TEXT]... [--budget N] [--json] TASK...
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectPackInput } from "../core/pack/collect.ts";
import { type AdvisorKind, buildReviewPack } from "../core/pack/index.ts";

export interface CliArgs {
	cwd: string;
	kind: AdvisorKind;
	task: string;
	plan?: string;
	claims: string[];
	budget?: number;
	json: boolean;
	model?: string;
	maxTokens?: number;
	noCache: boolean;
}

/** Pure: parse argv (without node + script). */
export function parseArgs(argv: string[]): CliArgs {
	const a: CliArgs = { cwd: process.cwd(), kind: "review", task: "", claims: [], json: false, noCache: false };
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const x = argv[i]!;
		const val = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${x} needs a value`);
			return v;
		};
		if (x === "--cwd") a.cwd = resolve(val());
		else if (x === "--kind") {
			const k = val();
			if (k !== "review" && k !== "help" && k !== "plan") throw new Error(`--kind must be review|help|plan`);
			a.kind = k;
		} else if (x === "--plan") a.plan = readFileSync(val(), "utf8");
		else if (x === "--claim") a.claims.push(val());
		else if (x === "--budget") a.budget = Number(val());
		else if (x === "--model") a.model = val();
		else if (x === "--max-tokens") a.maxTokens = Number(val());
		else if (x === "--no-cache") a.noCache = true;
		else if (x === "--json") a.json = true;
		else if (x === "--") continue;
		else if (x === "--task-file") rest.push(readFileSync(val(), "utf8"));
		else rest.push(x);
	}
	a.task = rest.join(" ").trim();
	if (!a.task) throw new Error("task is required (positional text or --task-file)");
	return a;
}

export async function packFromArgs(a: CliArgs) {
	const input = await collectPackInput({ kind: a.kind, cwd: a.cwd, task: a.task, plan: a.plan, claims: a.claims, budgetTokens: a.budget });
	return buildReviewPack(input, { budgetTokens: a.budget });
}

export async function main() {
	const a = parseArgs(process.argv.slice(2));
	const pack = await packFromArgs(a);
	if (a.json) process.stdout.write(`${JSON.stringify(pack, null, 2)}\n`);
	else {
		for (const m of pack.messages) process.stdout.write(`===== ${m.role}${m.cache ? " (cacheable prefix)" : ""} =====\n${m.content}\n\n`);
		process.stderr.write(`baton-pack: ~${pack.tokens} tokens (stable prefix ~${pack.stableTokens})${pack.overBudget ? ", OVER BUDGET" : ""}\n`);
	}
}

/** Entry point used by bin/baton-pack.mjs. */
export function run(): void {
	main().catch((e) => {
		process.stderr.write(`baton-pack: ${(e as Error).message}\n`);
		process.exit(2);
	});
}
