import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clip, matchesAny } from "./util.ts";

export type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;

export async function git(exec: Exec, args: string[]): Promise<string | undefined> {
	try {
		const r = await exec("git", args);
		return r.code === 0 ? r.stdout : undefined;
	} catch {
		return undefined;
	}
}

export function splitNul(out: string): string[] {
	return out.split("\0").filter((p) => p.length > 0);
}

export async function gitRoot(exec: Exec, cwd: string): Promise<string> {
	const top = (await git(exec, ["rev-parse", "--show-toplevel"]))?.trim();
	return top || cwd;
}

const BINARY_PROBE = 8192;

export function readRepoText(abs: string): string | undefined {
	if (!existsSync(abs)) return undefined;
	try {
		const buf = readFileSync(abs);
		if (buf.subarray(0, Math.min(buf.length, BINARY_PROBE)).includes(0)) return undefined;
		return buf.toString("utf8");
	} catch {
		return undefined;
	}
}

export function formatRepoFile(abs: string, maxLines: number): string {
	if (!existsSync(abs)) return "(deleted)";
	try {
		const buf = readFileSync(abs);
		if (buf.subarray(0, Math.min(buf.length, BINARY_PROBE)).includes(0)) return `(binary, ${buf.length} bytes)`;
		const text = buf.toString("utf8");
		const lines = text.split("\n");
		return lines.length <= maxLines ? text : `(${lines.length} lines; too long, see diff)`;
	} catch {
		return "(unreadable)";
	}
}

/** Pure: the journal dir plus configured globs; always applied, regardless of .gitignore. */
export function packExcludes(journalDir: string, extra: readonly string[]): string[] {
	const j = journalDir.replace(/^\.\//, "").replace(/\/+$/, "");
	return [...new Set([`${j}/**`, ".pi/baton/**", ...extra])];
}

/** Pure: git pathspec args (`-- . :(exclude,glob)…`) that drop excluded paths from diff/name lists. */
export function excludePathspec(excludes: readonly string[]): string[] {
	return ["--", ".", ...excludes.map((g) => `:(exclude,glob)${g}`)];
}

/** git diff [args] with the pack excludes; falls back to the unstaged diff when there is no HEAD. */
export async function packDiff(exec: Exec, args: string[], excludes: readonly string[]): Promise<string | undefined> {
	const spec = excludePathspec(excludes);
	return (await git(exec, ["diff", ...args, "HEAD", ...spec])) ?? (await git(exec, ["diff", ...args, ...spec]));
}

/** Commit-ish of the current working tree (tracked files) without touching it: `git stash create`, or HEAD when clean. */
export async function treeSnapshot(exec: Exec): Promise<string | undefined> {
	const s = (await git(exec, ["stash", "create"]))?.trim();
	return s || (await git(exec, ["rev-parse", "HEAD"]))?.trim() || undefined;
}

/** Pure: sum of added+deleted lines in `git diff --numstat` output (binary files count 0). */
export function numstatLines(out: string): number {
	let n = 0;
	for (const l of out.split("\n")) {
		const m = l.match(/^(\d+)\s+(\d+)\s/);
		if (m) n += Number(m[1]) + Number(m[2]);
	}
	return n;
}

/** Changed lines between a snapshot and the current tree, with the pack excludes. */
export async function diffLinesSince(exec: Exec, from: string, excludes: readonly string[]): Promise<number | undefined> {
	const to = await treeSnapshot(exec);
	if (!to) return undefined;
	const out = await git(exec, ["diff", "--numstat", from, to, ...excludePathspec(excludes)]);
	return out === undefined ? undefined : numstatLines(out);
}

export async function changedFiles(exec: Exec, cwd: string, maxLines = 400, excludes: readonly string[] = [".pi/baton/**"]): Promise<{ path: string; content: string }[]> {
	const root = await gitRoot(exec, cwd);
	const tracked = splitNul((await git(exec, ["diff", "--name-only", "-z", "HEAD"])) ?? (await git(exec, ["diff", "--name-only", "-z"])) ?? "");
	const untracked = splitNul((await git(exec, ["ls-files", "--others", "--exclude-standard", "-z", "--full-name"])) ?? "");
	const paths = [...new Set([...tracked, ...untracked])].filter((p) => !matchesAny(p, excludes));
	return paths.slice(0, 40).map((p) => ({ path: p, content: formatRepoFile(join(root, p), maxLines) }));
}

const SYMBOL = /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|const|enum|def|fn|func|struct|trait|impl)\s+([A-Za-z_][\w]*)/;

/** Pure: Aider-style light repo map from file list + file reader. */
export function repoMap(files: string[], read: (p: string) => string | undefined, budgetChars: number): string {
	const lines: string[] = [];
	for (const f of files) {
		const syms: string[] = [];
		if (/\.(ts|tsx|js|mjs|py|go|rs)$/.test(f)) {
			const text = read(f);
			if (text && text.length < 200_000)
				for (const l of text.split("\n")) {
					const m = l.match(SYMBOL);
					if (m && (m[1] || /^(def|fn|func|struct|trait|class)$/.test(m[4]!))) syms.push(m[5]!);
					if (syms.length >= 12) break;
				}
		}
		lines.push(syms.length ? `${f}: ${syms.join(", ")}` : f);
	}
	return clip(lines.join("\n"), budgetChars);
}

export function readAgentsMd(cwd: string): string | undefined {
	for (const name of ["AGENTS.md", "CLAUDE.md", ".cursorrules"]) {
		const p = join(cwd, name);
		if (existsSync(p)) return clip(readFileSync(p, "utf8"), 12_000);
	}
	return undefined;
}
