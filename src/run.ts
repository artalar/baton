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
