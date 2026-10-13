import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorLines } from "./calls.ts";

export interface CheckCommand {
	kind: string;
	command: string;
}

export interface CheckResult extends CheckCommand {
	passed: boolean;
	exitCode: number | null;
	timedOut: boolean;
	output: string;
	durationMs: number;
}

const MAX_CAPTURED_OUTPUT = 400_000;

function packageScripts(cwd: string): Record<string, string> | undefined {
	try {
		const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
		return manifest.scripts ?? {};
	} catch {
		return undefined;
	}
}

/** Typecheck, tests and the production build, from package.json scripts (or `tsc --noEmit` when only a tsconfig exists). */
export function detectChecks(cwd: string, overrides?: string[]): CheckCommand[] {
	if (overrides?.length) return overrides.map((command) => ({ kind: command.split(/\s+/).slice(0, 3).join(" "), command }));
	const scripts = packageScripts(cwd);
	if (!scripts) return [];
	const checks: CheckCommand[] = [];
	if (scripts.typecheck) checks.push({ kind: "typecheck", command: "npm run -s typecheck" });
	else if (existsSync(join(cwd, "tsconfig.json")) && !/\btsc\b/.test(scripts.build ?? "")) checks.push({ kind: "typecheck", command: "npx --no-install tsc --noEmit" });
	if (scripts.test && !/no test specified/.test(scripts.test)) checks.push({ kind: "test", command: "npm test --silent" });
	if (scripts.build) checks.push({ kind: "build", command: "npm run -s build" });
	return checks;
}

function killGroup(child: ChildProcess): void {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

/** Runs one shell command in its own process group; the whole group is killed on timeout. */
export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", command], { cwd, detached: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const capture = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > MAX_CAPTURED_OUTPUT) output = output.slice(-MAX_CAPTURED_OUTPUT / 2);
		};
		child.stdout?.on("data", capture);
		child.stderr?.on("data", capture);
		let settled = false;
		const settle = (exitCode: number | null, timedOut: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode, output, timedOut });
		};
		const timer = setTimeout(() => {
			killGroup(child);
			settle(null, true);
		}, timeoutMs);
		child.on("error", (error) => {
			output += `\n${error.message}`;
			settle(null, false);
		});
		child.on("close", (exitCode) => settle(exitCode, false));
	});
}

export async function runChecks(cwd: string, checks: CheckCommand[], timeoutMs: number): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	for (const check of checks) {
		const startedAt = Date.now();
		const { exitCode, output, timedOut } = await runCommand(check.command, cwd, timeoutMs);
		results.push({ ...check, passed: exitCode === 0 && !timedOut, exitCode, timedOut, output, durationMs: Date.now() - startedAt });
	}
	return results;
}

export function describeCheck(result: CheckResult, failureChars = 1_200): string {
	const status = result.passed ? "PASS" : result.timedOut ? "TIMEOUT" : `FAIL (exit ${result.exitCode ?? "?"})`;
	const header = `- ${result.kind}: \`${result.command}\` → ${status}`;
	if (result.passed) return header;
	const flagged = errorLines(result.output, 8).join("\n");
	const tail = result.output.trim().slice(-failureChars);
	return `${header}\n${indent(flagged && !tail.includes(flagged) ? `${flagged}\n…\n${tail}` : tail)}`;
}

const indent = (text: string) =>
	text
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
