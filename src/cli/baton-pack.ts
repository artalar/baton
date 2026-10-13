#!/usr/bin/env node
/**
 * baton-pack: print the advisor pack for a repository + task. No LLM call.
 *   baton-pack [--cwd DIR] [--kind review|help|plan] [--plan FILE] [--claim TEXT]... [--budget N] [--json] TASK...
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

export type CliParse = { help: true } | { version: true } | CliArgs;

export function packUsage(): string {
	return [
		"baton-pack: print the advisor pack for a repository and a task. No LLM call.",
		"Usage: baton-pack [options] TASK...",
		"",
		"Options:",
		"  --cwd DIR              repository directory (default: cwd)",
		"  --kind review|help|plan",
		"  --plan FILE            pinned plan file",
		"  --claim TEXT           executor claim (repeatable)",
		"  --budget N             pack budget in tokens (positive integer)",
		"  --json                 print the pack as JSON",
		"  --task-file FILE       read the task from a file",
		"  -h, --help             show this help",
		"  -V, --version          print the package version",
		"",
	].join("\n");
}

export function packageVersion(from: string = import.meta.url): string {
	let dir = dirname(fileURLToPath(from));
	for (;;) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			const version = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown }).version;
			if (typeof version === "string" && version) return version;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("package.json not found");
}

function positiveInt(flag: string, raw: string): number {
	if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${flag} must be a positive integer`);
	const n = Number(raw);
	if (!Number.isSafeInteger(n)) throw new Error(`${flag} must be a positive integer`);
	return n;
}

export function parseArgs(argv: string[]): CliParse {
	const a: CliArgs = { cwd: process.cwd(), kind: "review", task: "", claims: [], json: false, noCache: false };
	const rest: string[] = [];
	let positional = false;
	for (let i = 0; i < argv.length; i++) {
		const x = argv[i]!;
		if (positional) {
			rest.push(x);
			continue;
		}
		const val = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${x} needs a value`);
			return v;
		};
		if (x === "--") positional = true;
		else if (x === "--help" || x === "-h") return { help: true };
		else if (x === "--version" || x === "-V") return { version: true };
		else if (x === "--cwd") a.cwd = resolve(val());
		else if (x === "--kind") {
			const k = val();
			if (k !== "review" && k !== "help" && k !== "plan") throw new Error(`--kind must be review|help|plan`);
			a.kind = k;
		} else if (x === "--plan") a.plan = readFileSync(val(), "utf8");
		else if (x === "--claim") a.claims.push(val());
		else if (x === "--budget") a.budget = positiveInt("--budget", val());
		else if (x === "--model") a.model = val();
		else if (x === "--max-tokens") a.maxTokens = positiveInt("--max-tokens", val());
		else if (x === "--no-cache") a.noCache = true;
		else if (x === "--json") a.json = true;
		else if (x === "--task-file") rest.push(readFileSync(val(), "utf8"));
		else if (x.startsWith("-")) throw new Error(`unknown option ${x}`);
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

export async function main(argv: string[] = process.argv.slice(2)) {
	const parsed = parseArgs(argv);
	if ("help" in parsed) {
		process.stdout.write(packUsage());
		return;
	}
	if ("version" in parsed) {
		process.stdout.write(`${packageVersion()}\n`);
		return;
	}
	const a = parsed;
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
