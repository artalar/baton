/**
 * Working-tree snapshots around helper tool calls.
 * Revert only when both snapshots succeeded and HEAD is unchanged.
 * Path lists use --literal-pathspecs so a name like app/[id].tsx is not a glob.
 * Status excludes stay magic pathspecs (`:(exclude)`); literal mode would disable them.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface Snap {
	ok: boolean;
	/** `git rev-parse --show-toplevel`; porcelain paths are relative to this, not to cwd. */
	root: string;
	head: string;
	/** dirty / untracked paths → "XY:size:mtimeMs" ("XY:-" when missing on disk) */
	files: Map<string, string>;
	nodeModules: string;
	/** contents of dirty/untracked files (reading phases only; files ≤ maxBytes) */
	contents?: Map<string, Buffer | null>;
	ms: number;
	takenAt: number;
	indexSig: string;
	gitignoreSig: string;
}

export const DEFAULT_MAX_REVERT = 50;

type GitFn = (cwd: string, args: string[], opts?: { literal?: boolean }) => string;

function defaultGit(cwd: string, args: string[], opts?: { literal?: boolean }): string {
	const full = opts?.literal ? ["--literal-pathspecs", ...args] : args;
	return execFileSync("git", full, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
}

let gitFn: GitFn = defaultGit;

/** Tests inject a runner that throws on `ls-files` (argv too long). Pass undefined to restore. */
export function setFsGitForTests(fn: GitFn | undefined): void {
	gitFn = fn ?? defaultGit;
}

export function runGit(cwd: string, args: string[], opts?: { literal?: boolean }): string {
	return gitFn(cwd, args, opts);
}

const sigOf = (root: string, p: string, xy: string) => {
	try {
		const st = lstatSync(join(root, p));
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
 * Build / test / tool artefacts are never "changes". git status already drops gitignored paths; this
 * also covers repos whose .gitignore misses them (dist, coverage, .vite, vitest/jest caches, tsbuildinfo …).
 */
export const ARTIFACT = /(^|\/)(dist|build|out|coverage|\.nyc_output|\.vite|\.vitest|\.turbo|\.next|\.nuxt|\.parcel-cache|\.cache|\.eslintcache|\.pi|__snapshots__\/.*\.snap\.tmp)(\/|$)|\.tsbuildinfo$|(^|\/)vite\.config\.[cm]?[jt]s\.timestamp-[^/]*$|(^|\/)\.DS_Store$/;

/** node_modules signature: the package managers' own install markers, not the directory mtime
 * (vite/vitest create node_modules/.vite and .cache on every run, which bumps the directory mtime). */
const NM_MARKERS = [".package-lock.json", ".modules.yaml", ".yarn-integrity", ".yarn-state.yml"];

function indexSignature(root: string): string {
	try {
		const rel = runGit(root, ["rev-parse", "--git-path", "index"]).trim();
		const abs = isAbsolute(rel) ? rel : join(root, rel);
		const st = statSync(abs);
		return `${st.size}:${Math.round(st.mtimeMs)}`;
	} catch {
		return "-";
	}
}

function digest(abs: string): string {
	try {
		return createHash("sha1").update(readFileSync(abs)).digest("hex");
	} catch {
		return "-";
	}
}

function gitignoreSignature(root: string): string {
	const paths = new Set<string>([join(root, ".gitignore")]);
	try {
		const exclude = runGit(root, ["rev-parse", "--git-path", "info/exclude"]).trim();
		paths.add(isAbsolute(exclude) ? exclude : join(root, exclude));
	} catch {
		/* no exclude file */
	}
	try {
		const listed = runGit(root, ["ls-files", "-z", "-co", "--exclude-standard", "--", ":(glob)**/.gitignore", ".gitignore"]);
		for (const p of listed.split("\0")) if (p === ".gitignore" || p.endsWith("/.gitignore")) paths.add(join(root, p));
	} catch {
		/* status already proved the repo is readable */
	}
	return [...paths].sort().map((abs) => `${abs}:${digest(abs)}`).join("|");
}

function emptySnap(takenAt: number, ms: number, nodeModules: string): Snap {
	return { ok: false, root: "", head: "", files: new Map(), nodeModules, contents: undefined, ms, takenAt, indexSig: "", gitignoreSig: "" };
}

export function snapshot(cwd: string, opts: { contents?: boolean; maxBytes?: number } = {}): Snap {
	const t0 = performance.now();
	const takenAt = Date.now();
	let root = "";
	let head = "";
	const files = new Map<string, string>();
	let contents: Map<string, Buffer | null> | undefined;
	let indexSig = "";
	let gitignoreSig = "";
	let ok = false;
	try {
		root = runGit(cwd, ["rev-parse", "--show-toplevel"]).trim();
		const r = parseStatusV2(runGit(cwd, ["status", "--porcelain=v2", "-z", "--branch", "-uall", "--", ".", ":(exclude)node_modules", ":(exclude).git"]));
		head = r.head;
		indexSig = indexSignature(root);
		gitignoreSig = gitignoreSignature(root);
		if (opts.contents) contents = new Map();
		for (const [p, xy] of r.entries) {
			if (ARTIFACT.test(p)) continue;
			files.set(p, sigOf(root, p, xy));
			if (contents) {
				try {
					const st = lstatSync(join(root, p));
					if (st.isSymbolicLink()) contents.set(p, null);
					else contents.set(p, st.isFile() && st.size <= (opts.maxBytes ?? 2 << 20) ? readFileSync(join(root, p)) : null);
				} catch {
					contents.set(p, null);
				}
			}
		}
		ok = true;
	} catch {
		ok = false;
	}
	const base = root || cwd;
	let nodeModules = "-";
	try {
		statSync(join(base, "node_modules"));
		nodeModules = NM_MARKERS.map((m) => {
			try {
				const st = statSync(join(base, "node_modules", m));
				return `${m}:${st.size}:${Math.round(st.mtimeMs)}`;
			} catch {
				return "";
			}
		}).join("|") || "present";
	} catch {
		/* none */
	}
	if (!ok) return { ...emptySnap(takenAt, performance.now() - t0, nodeModules), root, head, files, contents };
	return { ok, root, head, files, nodeModules, contents, ms: performance.now() - t0, takenAt, indexSig, gitignoreSig };
}

export interface SnapDiff {
	changed: string[];
	headChanged: boolean;
	nodeModulesChanged: boolean;
	ok: boolean;
}

export function diffSnaps(a: Snap, b: Snap): SnapDiff {
	const changed = new Set<string>();
	for (const [p, s] of b.files) if (a.files.get(p) !== s) changed.add(p);
	for (const p of a.files.keys()) if (!b.files.has(p)) changed.add(p);
	return { changed: [...changed].sort(), headChanged: a.head !== b.head, nodeModulesChanged: a.nodeModules !== b.nodeModules, ok: a.ok && b.ok };
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
	skipped: string[];
	backupDir?: string;
	aborted?: boolean;
	abortReason?: string;
}

const abortRevert = (paths: string[], abortReason: string): RevertResult => ({ restored: [], removed: [], failed: [...paths], skipped: [], aborted: true, abortReason });

function createdByCall(st: Stats, takenAt: number): boolean {
	const times = [st.birthtimeMs, st.ctimeMs].filter((n) => Number.isFinite(n) && n > 0);
	if (!times.length) return false;
	return Math.min(...times) >= takenAt;
}

function insideRoot(root: string, abs: string): boolean {
	const rel = relative(root, abs);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Undo `paths` back to the `pre` snapshot. Clean tracked files return to HEAD in both the index and the
 * worktree. Files created by the call are removed only when their birth/ctime is after the snapshot.
 * Aborts without deleting anything when git cannot list the paths, the snapshot is unusable, HEAD moved,
 * too many paths are involved, or a gitignore/index change exposed previously ignored files.
 */
export function revertTo(cwd: string, pre: Snap, paths: string[], backupDir: string, maxPaths = DEFAULT_MAX_REVERT): RevertResult {
	const res: RevertResult = { restored: [], removed: [], failed: [], skipped: [] };
	if (!paths.length) return res;
	if (!pre.ok || !pre.root) return abortRevert(paths, "pre-snapshot is not usable");
	if (maxPaths <= 0) return abortRevert(paths, "revert cap 0");
	if (paths.length > maxPaths) return abortRevert(paths, `revert cap ${maxPaths} exceeded (${paths.length} paths)`);
	const root = pre.root;
	let headNow = "";
	try {
		headNow = runGit(root, ["rev-parse", "HEAD"]).trim();
	} catch {
		return abortRevert(paths, "cannot read HEAD");
	}
	if (!pre.head || headNow !== pre.head) return abortRevert(paths, "HEAD changed; not reverting");
	let tracked = new Set<string>();
	try {
		tracked = new Set(runGit(root, ["ls-files", "-z", "--", ...paths], { literal: true }).split("\0").filter(Boolean));
	} catch {
		return abortRevert(paths, "git ls-files failed; not reverting");
	}
	const gitignoreChanged = gitignoreSignature(root) !== pre.gitignoreSig;
	const indexChanged = indexSignature(root) !== pre.indexSig;
	if (gitignoreChanged || indexChanged) {
		for (const p of paths) {
			if (pre.files.has(p) || tracked.has(p)) continue;
			const abs = resolve(root, p);
			if (!insideRoot(root, abs) || !existsSync(abs)) continue;
			let st: Stats;
			try {
				st = lstatSync(abs);
			} catch {
				continue;
			}
			if (!createdByCall(st, pre.takenAt)) return abortRevert(paths, "gitignore or index change exposed previously ignored files; not reverting");
		}
	}
	mkdirSync(backupDir, { recursive: true });
	res.backupDir = backupDir;
	try {
		writeFileSync(join(backupDir, "changes.patch"), runGit(root, ["diff", "--", ...paths], { literal: true }));
	} catch {
		/* best effort */
	}
	for (const p of paths) {
		const abs = resolve(root, p);
		if (!insideRoot(root, abs)) {
			res.failed.push(p);
			continue;
		}
		let before: Stats | undefined;
		try {
			before = lstatSync(abs);
		} catch {
			before = undefined;
		}
		if (before?.isFile() && !before.isSymbolicLink()) {
			try {
				mkdirSync(dirname(join(backupDir, "files", p)), { recursive: true });
				copyFileSync(abs, join(backupDir, "files", p));
			} catch {
				/* unreadable */
			}
		}
		try {
			if (pre.files.has(p)) {
				const saved = pre.contents?.get(p);
				const record = pre.files.get(p)!;
				const wasMissing = record.endsWith(":-");
				const xy = record.slice(0, 2);
				if (before?.isSymbolicLink()) {
					res.failed.push(p);
					res.skipped.push(p);
					continue;
				}
				if (wasMissing) {
					if (before && !createdByCall(before, pre.takenAt)) {
						res.failed.push(p);
						continue;
					}
					if (before?.isDirectory()) {
						res.failed.push(p);
						res.skipped.push(p);
						continue;
					}
					if (before) rmSync(abs, { force: true });
					res.removed.push(p);
				} else if (saved && !before?.isDirectory()) {
					mkdirSync(dirname(abs), { recursive: true });
					writeFileSync(abs, saved);
					const mt = Number(record.split(":").slice(2).join(":"));
					if (mt) utimesSync(abs, new Date(mt), new Date(mt));
					if (xy !== "??" && (xy[0] === "." || xy[0] === " ")) runGit(root, ["restore", "--source=HEAD", "--staged", "--", p], { literal: true });
					res.restored.push(p);
				} else res.failed.push(p);
			} else if (tracked.has(p)) {
				if (before?.isSymbolicLink()) {
					res.failed.push(p);
					res.skipped.push(p);
					continue;
				}
				runGit(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", p], { literal: true });
				res.restored.push(p);
			} else if (!before) {
				res.removed.push(p);
			} else if (before.isSymbolicLink()) {
				if (!createdByCall(before, pre.takenAt)) {
					res.failed.push(p);
					res.skipped.push(p);
					continue;
				}
				unlinkSync(abs);
				res.removed.push(p);
			} else if (before.isDirectory()) {
				res.failed.push(p);
				res.skipped.push(p);
			} else if (!createdByCall(before, pre.takenAt)) {
				res.failed.push(p);
			} else {
				rmSync(abs, { force: true });
				res.removed.push(p);
				for (let d = dirname(abs); insideRoot(root, d) && d !== root; d = dirname(d)) {
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

/** Full uncommitted diff, including untracked files, without `git add -N` touching the user's index. */
export function diffVsHead(cwd: string): string {
	const root = runGit(cwd, ["rev-parse", "--show-toplevel"]).trim();
	let indexSrc = "";
	try {
		const rel = runGit(root, ["rev-parse", "--git-path", "index"]).trim();
		indexSrc = isAbsolute(rel) ? rel : join(root, rel);
	} catch {
		indexSrc = "";
	}
	const dir = mkdtempSync(join(tmpdir(), "baton-idx-"));
	const tmpIndex = join(dir, "index");
	try {
		if (indexSrc && existsSync(indexSrc)) copyFileSync(indexSrc, tmpIndex);
		else writeFileSync(tmpIndex, "");
		const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
		execFileSync("git", ["add", "-N", "."], { cwd: root, env, stdio: ["ignore", "pipe", "ignore"] });
		return execFileSync("git", ["diff", "HEAD", "--", ".", ":!package-lock.json"], { cwd: root, env, encoding: "utf8", timeout: 10_000, maxBuffer: 20_000_000 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
