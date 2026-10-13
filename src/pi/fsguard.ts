/**
 * Baton switch: cheap working-tree change detection around helper tool calls (v0.8.1).
 * snapshot = HEAD + `git status --porcelain=v2 -z -uall` (node_modules/.git excluded) + size/mtime of every listed
 * path + node_modules mtime. Clean tracked files are covered by git's own index stat check, so only dirty/untracked
 * paths need a stat. In a reading phase the caller may also keep the contents of dirty/untracked files so that a
 * change made by the helper can be undone exactly.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface Snap {
	head: string;
	/** dirty / untracked paths → "XY:size:mtimeMs" ("XY:-" when missing on disk) */
	files: Map<string, string>;
	nodeModules: string;
	/** contents of dirty/untracked files (reading phases only; files ≤ maxBytes) */
	contents?: Map<string, Buffer | null>;
	ms: number;
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });

const sig = (cwd: string, p: string, xy: string) => {
	try {
		const st = statSync(join(cwd, p));
		return `${xy}:${st.size}:${Math.round(st.mtimeMs)}`;
	} catch {
		return `${xy}:-`;
	}
};

/** Parse `git status --porcelain=v2 -z --branch` output. */
export function parseStatusV2(out: string): { head: string; entries: [string, string][] } {
	const toks = out.split("\0");
	let head = "";
	const entries: [string, string][] = [];
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i]!;
		if (!t) continue;
		if (t.startsWith("# branch.oid ")) head = t.slice(13);
		else if (t.startsWith("1 ")) entries.push([t.split(" ").slice(8).join(" "), t.slice(2, 4)]);
		else if (t.startsWith("2 ")) {
			entries.push([t.split(" ").slice(9).join(" "), t.slice(2, 4)]);
			i++; // original path
		} else if (t.startsWith("u ")) entries.push([t.split(" ").slice(10).join(" "), t.slice(2, 4)]);
		else if (t.startsWith("? ")) entries.push([t.slice(2), "??"]);
	}
	return { head, entries };
}

/**
 * 0.11: build / test / tool artefacts are never "changes". git status already drops gitignored paths; this
 * also covers repos whose .gitignore misses them (dist, coverage, .vite, vitest/jest caches, tsbuildinfo …).
 */
export const ARTIFACT = /(^|\/)(dist|build|out|coverage|\.nyc_output|\.vite|\.vitest|\.turbo|\.next|\.nuxt|\.parcel-cache|\.cache|\.eslintcache|\.pi|__snapshots__\/.*\.snap\.tmp)(\/|$)|\.tsbuildinfo$|(^|\/)vite\.config\.[cm]?[jt]s\.timestamp-[^/]*$|(^|\/)\.DS_Store$/;

/** node_modules signature: the package managers' own install markers, not the directory mtime
 * (vite/vitest create node_modules/.vite and .cache on every run, which bumps the directory mtime). */
const NM_MARKERS = [".package-lock.json", ".modules.yaml", ".yarn-integrity", ".yarn-state.yml"];

export function snapshot(cwd: string, opts: { contents?: boolean; maxBytes?: number } = {}): Snap {
	const t0 = performance.now();
	let head = "";
	const files = new Map<string, string>();
	let contents: Map<string, Buffer | null> | undefined;
	try {
		const r = parseStatusV2(git(cwd, ["status", "--porcelain=v2", "-z", "--branch", "-uall", "--", ".", ":(exclude)node_modules", ":(exclude).git"]));
		head = r.head;
		if (opts.contents) contents = new Map();
		for (const [p, xy] of r.entries) {
			if (ARTIFACT.test(p)) continue;
			files.set(p, sig(cwd, p, xy));
			if (contents) {
				try {
					const st = statSync(join(cwd, p));
					contents.set(p, st.isFile() && st.size <= (opts.maxBytes ?? 2 << 20) ? readFileSync(join(cwd, p)) : null);
				} catch {
					contents.set(p, null);
				}
			}
		}
	} catch {
		/* not a git repo: empty snapshot */
	}
	let nodeModules = "-";
	try {
		statSync(join(cwd, "node_modules"));
		nodeModules = NM_MARKERS.map((m) => {
			try {
				const st = statSync(join(cwd, "node_modules", m));
				return `${m}:${st.size}:${Math.round(st.mtimeMs)}`;
			} catch {
				return "";
			}
		}).join("|") || "present";
	} catch {
		/* none */
	}
	return { head, files, nodeModules, contents, ms: performance.now() - t0 };
}

export interface SnapDiff {
	changed: string[];
	headChanged: boolean;
	nodeModulesChanged: boolean;
}

export function diffSnaps(a: Snap, b: Snap): SnapDiff {
	const changed = new Set<string>();
	for (const [p, s] of b.files) if (a.files.get(p) !== s) changed.add(p);
	for (const p of a.files.keys()) if (!b.files.has(p)) changed.add(p);
	return { changed: [...changed].sort(), headChanged: a.head !== b.head, nodeModulesChanged: a.nodeModules !== b.nodeModules };
}

export const PROTECTED = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;
const INSTALL = /^(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|^(?:npx|pnpm\s+dlx|bunx)\s+/;
const NON_IDEMPOTENT = /^(?:git\s+(?:commit|push|reset|stash|checkout|switch|rebase|merge|tag|clean)|curl\b.*\s-[oO]|wget\b|npm\s+publish|(?:rm|mv|cp)\s+.*(?:^|\s)(?:\/|~))/;

export interface Classified {
	/** the call is a package install (safe-ish: recorded, never reverted, no handover by itself) */
	install: boolean;
	/** non-revertible effects (HEAD moved, outside-repo deletes, network downloads …) */
	nonIdempotent: string[];
	/** repo files to revert */
	revert: string[];
	/** changed but intentionally kept (package.json / lockfiles / node_modules) */
	keep: string[];
}

/** Pure: classify the effects of one call. `segments` = executed command segments (see executedSegments). */
export function classifyEffects(d: SnapDiff, segments: string[]): Classified {
	const install = segments.some((s) => INSTALL.test(s));
	const nonIdempotent: string[] = [];
	if (d.headChanged) nonIdempotent.push("git HEAD moved");
	for (const s of segments) if (NON_IDEMPOTENT.test(s)) nonIdempotent.push(`ran: ${s.slice(0, 120)}`);
	if (d.nodeModulesChanged && !install) nonIdempotent.push("node_modules changed");
	const keep = d.changed.filter((p) => PROTECTED.test(p));
	if (d.nodeModulesChanged) keep.push("node_modules/");
	const revert = d.changed.filter((p) => !PROTECTED.test(p));
	return { install, nonIdempotent, revert, keep };
}

export interface RevertResult {
	restored: string[];
	removed: string[];
	failed: string[];
	backupDir?: string;
}

/**
 * Undo `paths` back to the `pre` snapshot: dirty/untracked files from their saved contents, clean tracked files from
 * the index (`git checkout --`), files created by the call are removed. A backup (copies + `git diff` patch) is
 * written to `backupDir` first.
 */
export function revertTo(cwd: string, pre: Snap, paths: string[], backupDir: string): RevertResult {
	const res: RevertResult = { restored: [], removed: [], failed: [] };
	if (!paths.length) return res;
	mkdirSync(backupDir, { recursive: true });
	res.backupDir = backupDir;
	try {
		writeFileSync(join(backupDir, "changes.patch"), git(cwd, ["diff", "--", ...paths]));
	} catch {
		/* best effort */
	}
	let tracked = new Set<string>();
	try {
		tracked = new Set(git(cwd, ["ls-files", "-z", "--", ...paths]).split("\0").filter(Boolean));
	} catch {
		/* none */
	}
	const root = resolve(cwd);
	for (const p of paths) {
		const abs = resolve(cwd, p);
		if (relative(root, abs).startsWith("..")) {
			res.failed.push(p);
			continue;
		}
		if (existsSync(abs)) {
			try {
				mkdirSync(dirname(join(backupDir, "files", p)), { recursive: true });
				copyFileSync(abs, join(backupDir, "files", p));
			} catch {
				/* dirs etc. */
			}
		}
		try {
			if (pre.files.has(p)) {
				const saved = pre.contents?.get(p);
				const wasMissing = pre.files.get(p)!.endsWith(":-");
				if (wasMissing) {
					rmSync(abs, { force: true });
					res.removed.push(p);
				} else if (saved) {
					mkdirSync(dirname(abs), { recursive: true });
					writeFileSync(abs, saved);
					const mt = Number(pre.files.get(p)!.split(":")[2]);
					if (mt) utimesSync(abs, new Date(mt), new Date(mt)); // keep the snapshot signature stable
					res.restored.push(p);
				} else res.failed.push(p);
			} else if (tracked.has(p)) {
				git(cwd, ["checkout", "--", p]);
				res.restored.push(p);
			} else {
				rmSync(abs, { force: true, recursive: true });
				res.removed.push(p);
				// remove now-empty parent dirs the call created
				for (let d = dirname(abs); d.startsWith(root) && d !== root; d = dirname(d)) {
					try {
						rmdirSync(d);
					} catch {
						break;
					}
				}
			}
		} catch {
			res.failed.push(p);
		}
	}
	return res;
}
