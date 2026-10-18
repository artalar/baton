import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { isInside } from "./config.ts";

export interface RunCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	isError?: boolean;
	/** The harness refused to run the call. */
	blocked?: boolean;
	output?: string;
}

/** `undefined` content means the file did not exist. */
export interface FileChange {
	path: string;
	before: Buffer | undefined;
	after: Buffer | undefined;
}

export interface ActiveRun {
	number: number;
	startedAt: number;
	turns: number;
	calls: RunCall[];
	/** Content of each file before the helper first touched it with edit/write, by absolute path. */
	originals: Map<string, Buffer | undefined>;
	/** Tool call ids the harness refused to run. */
	blocked: Set<string>;
	worktree?: WorktreeSnapshot;
	/** The file the helper tried to change without being allowed to, relative to cwd. */
	blockedWrite?: string;
	stopRequested?: string;
}

export interface FinishedRun {
	number: number;
	stopReason: string;
	turns: number;
	callCount: number;
	changes: FileChange[];
	blockedWrite?: string;
	undone: Set<string>;
}

export interface UndoResult {
	restored: string[];
	deleted: string[];
	changedLater: string[];
	alreadyUndone: string[];
	notInRun: string[];
}

export const FILE_TOOLS = new Set(["edit", "write"]);

export const startRun = (number: number, startedAt: number): ActiveRun => ({ number, startedAt, turns: 0, calls: [], originals: new Map(), blocked: new Set() });

/** Mirrors pi's path handling: a leading `@` is dropped, `~` is the home directory, relative paths start at cwd. */
export function resolveToolPath(cwd: string, rawPath: string): string {
	const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	const expanded = withoutAt === "~" || withoutAt.startsWith("~/") ? homedir() + withoutAt.slice(1) : withoutAt;
	return resolve(cwd, expanded);
}

/** Absolute path of the file an edit/write call targets. */
export function fileToolTarget(cwd: string, call: Pick<RunCall, "name" | "args">): string | undefined {
	if (!FILE_TOOLS.has(call.name) || typeof call.args.path !== "string") return undefined;
	return resolveToolPath(cwd, call.args.path);
}

/** The helper may change files the lead changed with edit/write in this session, and anything under the scratch directory. */
export const helperMayWrite = (absolutePath: string, leadFiles: ReadonlySet<string>, scratchDir: string) => leadFiles.has(absolutePath) || isInside(scratchDir, absolutePath);

function readContent(absolutePath: string): Buffer | undefined {
	try {
		return statSync(absolutePath).isFile() ? readFileSync(absolutePath) : undefined;
	} catch {
		return undefined;
	}
}

export function rememberOriginal(run: ActiveRun, cwd: string, call: Pick<RunCall, "name" | "args">): void {
	const absolutePath = fileToolTarget(cwd, call);
	if (absolutePath && !run.originals.has(absolutePath)) run.originals.set(absolutePath, readContent(absolutePath));
}

export function recordTurn(run: ActiveRun, calls: RunCall[]): void {
	run.turns++;
	run.calls.push(...calls);
}

const sameContent = (left: Buffer | undefined, right: Buffer | undefined) => (left === undefined || right === undefined ? left === right : left.equals(right));

export function collectChanges(run: ActiveRun, cwd: string): FileChange[] {
	const changes: FileChange[] = [];
	for (const [absolutePath, before] of run.originals) {
		const after = readContent(absolutePath);
		if (!sameContent(before, after)) changes.push({ path: relative(cwd, absolutePath) || absolutePath, before, after });
	}
	return changes;
}

export interface WorktreeSnapshot {
	status: string;
	diffStat: string;
}

export function captureWorktree(cwd: string): WorktreeSnapshot | undefined {
	const status = gitText(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
	const diffStat = gitText(cwd, ["diff", "--stat", "--relative"]);
	if (status === undefined || diffStat === undefined) return undefined;
	return { status, diffStat };
}

function gitText(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, "--no-pager", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
	} catch {
		return undefined;
	}
}

function unquoteGitPath(value: string): string {
	const trimmed = value.trim();
	if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed === "string" ? parsed : trimmed.slice(1, -1);
	} catch {
		return trimmed.slice(1, -1);
	}
}

function porcelainPaths(status: string): Map<string, string> {
	const paths = new Map<string, string>();
	for (const line of status.split("\n")) {
		if (line.length < 4) continue;
		for (const part of line.slice(3).split(" -> ")) {
			const path = unquoteGitPath(part);
			if (path) paths.set(path, line);
		}
	}
	return paths;
}

function diffStatPaths(stat: string): Map<string, string> {
	const paths = new Map<string, string>();
	for (const line of stat.split("\n")) {
		const bar = line.indexOf(" | ");
		if (bar <= 0) continue;
		const path = unquoteGitPath(line.slice(0, bar));
		if (path) paths.set(path, line.trim());
	}
	return paths;
}

export function pathsChangedSince(before: WorktreeSnapshot | undefined, after: WorktreeSnapshot | undefined, editWritePaths: readonly string[]): string[] {
	if (!before || !after) return [];
	const beforeStatus = porcelainPaths(before.status);
	const afterStatus = porcelainPaths(after.status);
	const beforeDiff = diffStatPaths(before.diffStat);
	const afterDiff = diffStatPaths(after.diffStat);
	const edited = new Set(editWritePaths);
	const changed: string[] = [];
	for (const path of new Set([...beforeStatus.keys(), ...afterStatus.keys(), ...beforeDiff.keys(), ...afterDiff.keys()])) {
		if (edited.has(path)) continue;
		if (beforeStatus.get(path) !== afterStatus.get(path) || beforeDiff.get(path) !== afterDiff.get(path)) changed.push(path);
	}
	changed.sort();
	return changed;
}

/** Restores files a run changed with edit/write, but only those still exactly as the run left them. */
export function undoRun(run: FinishedRun, cwd: string, paths?: string[]): UndoResult {
	const result: UndoResult = { restored: [], deleted: [], changedLater: [], alreadyUndone: [], notInRun: [] };
	const requested = paths?.map((path) => relative(cwd, resolveToolPath(cwd, path)));
	const selected = requested ? run.changes.filter((change) => requested.includes(change.path)) : run.changes;
	if (requested) result.notInRun = requested.filter((path) => !run.changes.some((change) => change.path === path));
	for (const change of selected) {
		if (run.undone.has(change.path)) {
			result.alreadyUndone.push(change.path);
			continue;
		}
		const absolutePath = resolve(cwd, change.path);
		if (!sameContent(readContent(absolutePath), change.after)) {
			result.changedLater.push(change.path);
			continue;
		}
		if (change.before === undefined) {
			if (existsSync(absolutePath)) rmSync(absolutePath);
			result.deleted.push(change.path);
		} else {
			mkdirSync(dirname(absolutePath), { recursive: true });
			writeFileSync(absolutePath, change.before);
			result.restored.push(change.path);
		}
		run.undone.add(change.path);
	}
	return result;
}
