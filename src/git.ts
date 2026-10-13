import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
	return execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: env ? { ...process.env, ...env } : process.env, stdio: ["ignore", "pipe", "pipe"] });
}

const gitError = (error: unknown) => {
	const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
	return (stderr || (error as Error).message || String(error)).split("\n")[0]!.slice(0, 200);
};

export function repoRoot(cwd: string): string | undefined {
	try {
		return git(cwd, ["rev-parse", "--show-toplevel"]).trim() || undefined;
	} catch {
		return undefined;
	}
}

let snapshotCounter = 0;

/**
 * The working tree as a git tree object (tracked and untracked files, .gitignore respected), built in a temporary
 * index so the user's index, HEAD and refs are untouched.
 */
export function snapshotTree(cwd: string): { tree: string } | { error: string } {
	const root = repoRoot(cwd);
	if (!root) return { error: "not a git repository" };
	const temporaryIndex = join(tmpdir(), `baton-index-${process.pid}-${Date.now()}-${snapshotCounter++}`);
	try {
		const realIndex = resolve(root, git(root, ["rev-parse", "--git-path", "index"]).trim());
		if (existsSync(realIndex)) copyFileSync(realIndex, temporaryIndex);
		const env = { GIT_INDEX_FILE: temporaryIndex };
		git(root, ["add", "-A", "--", "."], env);
		return { tree: git(root, ["write-tree"], env).trim() };
	} catch (error) {
		return { error: gitError(error) };
	} finally {
		rmSync(temporaryIndex, { force: true });
	}
}

export type ChangeStatus = "added" | "modified" | "deleted";
export interface ChangedPath {
	status: ChangeStatus;
	path: string;
}

const STATUS_BY_LETTER: Record<string, ChangeStatus> = { A: "added", D: "deleted" };

export function changedPaths(cwd: string, fromTree: string, toTree: string): ChangedPath[] {
	const root = repoRoot(cwd) ?? cwd;
	const fields = git(root, ["diff", "--name-status", "--no-renames", "-z", fromTree, toTree]).split("\0").filter(Boolean);
	const changes: ChangedPath[] = [];
	for (let index = 0; index + 1 < fields.length; index += 2) changes.push({ status: STATUS_BY_LETTER[fields[index]!.charAt(0)] ?? "modified", path: fields[index + 1]! });
	return changes;
}

export function treeDiff(cwd: string, fromTree: string, toTree: string): string {
	const root = repoRoot(cwd) ?? cwd;
	return git(root, ["diff", "--no-color", "--no-ext-diff", "--stat=120", "--patch", fromTree, toTree]);
}

export interface RollbackResult {
	restored: string[];
	removed: string[];
	keptChangedLater: string[];
	error?: string;
}

/**
 * Undoes one run: every path the run changed goes back to its checkpoint content, and files the run created are
 * deleted. A path that changed again after the run (by the lead) is left as it is.
 */
export function rollbackRun(cwd: string, startTree: string, endTree: string): RollbackResult {
	const result: RollbackResult = { restored: [], removed: [], keptChangedLater: [] };
	const root = repoRoot(cwd);
	if (!root) return { ...result, error: "not a git repository" };
	const current = snapshotTree(root);
	if ("error" in current) return { ...result, error: `cannot snapshot the working tree: ${current.error}` };
	try {
		const runChanges = changedPaths(root, startTree, endTree);
		const changedAfterRun = new Set(changedPaths(root, endTree, current.tree).map((change) => change.path));
		const toRestore: string[] = [];
		for (const change of runChanges) {
			if (changedAfterRun.has(change.path)) result.keptChangedLater.push(change.path);
			else if (change.status === "added") {
				if (existsSync(join(root, change.path))) unlinkSync(join(root, change.path));
				result.removed.push(change.path);
			} else toRestore.push(change.path);
		}
		if (toRestore.length) git(root, ["--literal-pathspecs", "restore", `--source=${startTree}`, "--worktree", "--", ...toRestore]);
		result.restored.push(...toRestore);
		return result;
	} catch (error) {
		return { ...result, error: gitError(error) };
	}
}
