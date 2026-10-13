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

export async function changedFiles(exec: Exec, cwd: string, maxLines = 400, excludes: readonly string[] = [".pi/baton/**"]): Promise<{ path: string; content: string }[]> {
	const tracked = (await git(exec, ["diff", "--name-only", "HEAD"])) ?? (await git(exec, ["diff", "--name-only"])) ?? "";
	const untracked = (await git(exec, ["ls-files", "--others", "--exclude-standard"])) ?? "";
	const paths = [...new Set([...tracked.split("\n"), ...untracked.split("\n")].map((s) => s.trim()).filter(Boolean))].filter((p) => !matchesAny(p, excludes));
	const out: { path: string; content: string }[] = [];
	for (const p of paths.slice(0, 40)) {
		const abs = join(cwd, p);
		if (!existsSync(abs)) {
			out.push({ path: p, content: "(deleted)" });
			continue;
		}
		try {
			const text = readFileSync(abs, "utf8");
			const lines = text.split("\n");
			out.push({ path: p, content: lines.length <= maxLines ? text : `(${lines.length} lines; too long, see diff)` });
		} catch {
			out.push({ path: p, content: "(unreadable)" });
		}
	}
	return out;
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
