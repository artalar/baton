import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectChecks, runChecks } from "../src/checks.ts";
import { changedPaths, rollbackRun, snapshotTree, treeDiff } from "../src/git.ts";
import { gitRepo } from "./helpers.ts";

const status = (dir: string) => execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
const tree = (dir: string) => {
	const result = snapshotTree(dir);
	if (!("tree" in result)) throw new Error(result.error);
	return result.tree;
};

describe("git checkpoints", () => {
	it("snapshots the working tree without touching the index", () => {
		const dir = gitRepo();
		writeFileSync(join(dir, "src/model.ts"), "export const model = 2;\n");
		writeFileSync(join(dir, "notes.txt"), "untracked\n");
		mkdirSync(join(dir, "ignored"));
		writeFileSync(join(dir, "ignored/cache"), "x");
		const before = status(dir);
		const start = tree(dir);
		expect(status(dir)).toBe(before);
		writeFileSync(join(dir, "src/view.ts"), "export {}\n");
		const end = tree(dir);
		expect(changedPaths(dir, start, end)).toEqual([{ status: "added", path: "src/view.ts" }]);
		expect(treeDiff(dir, start, end)).toContain("+export {}");
		expect(execFileSync("git", ["ls-tree", "-r", "--name-only", end], { cwd: dir, encoding: "utf8" })).not.toContain("ignored/cache");
	});

	it("rolls a run back, keeping earlier uncommitted work and files the lead changed after the run", () => {
		const dir = gitRepo({ "src/model.ts": "v1\n", "src/game.test.ts": "test\n", "src/other.ts": "o1\n", "src/[id].tsx": "page\n" });
		writeFileSync(join(dir, "src/model.ts"), "uncommitted lead work\n");
		const start = tree(dir);
		writeFileSync(join(dir, "src/model.ts"), "helper rewrite\n");
		writeFileSync(join(dir, "src/[id].tsx"), "helper page\n");
		execFileSync("rm", [join(dir, "src/game.test.ts")]);
		writeFileSync(join(dir, "src/new.ts"), "helper file\n");
		writeFileSync(join(dir, "src/other.ts"), "o2 by helper\n");
		const end = tree(dir);
		writeFileSync(join(dir, "src/other.ts"), "o3 by lead\n");

		const result = rollbackRun(dir, start, end);
		expect(result.error).toBeUndefined();
		expect(readFileSync(join(dir, "src/model.ts"), "utf8")).toBe("uncommitted lead work\n");
		expect(readFileSync(join(dir, "src/[id].tsx"), "utf8")).toBe("page\n");
		expect(readFileSync(join(dir, "src/game.test.ts"), "utf8")).toBe("test\n");
		expect(existsSync(join(dir, "src/new.ts"))).toBe(false);
		expect(readFileSync(join(dir, "src/other.ts"), "utf8")).toBe("o3 by lead\n");
		expect(result.keptChangedLater).toEqual(["src/other.ts"]);
		expect(result.removed).toEqual(["src/new.ts"]);
		expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" })).toBe("");
	});

	it("reports a directory outside git", () => {
		expect(snapshotTree(mkdtempSync(join(tmpdir(), "baton-nogit-")))).toEqual({ error: "not a git repository" });
	});
});

describe("project checks", () => {
	it("detects typecheck, test and build scripts", () => {
		const dir = gitRepo({ "package.json": JSON.stringify({ scripts: { test: "vitest run", build: "vite build" } }), "tsconfig.json": "{}" });
		expect(detectChecks(dir)).toEqual([
			{ kind: "typecheck", command: "npx --no-install tsc --noEmit" },
			{ kind: "test", command: "npm test --silent" },
			{ kind: "build", command: "npm run -s build" },
		]);
		expect(detectChecks(dir, ["make check"])).toEqual([{ kind: "make check", command: "make check" }]);
		expect(detectChecks(mkdtempSync(join(tmpdir(), "baton-empty-")))).toEqual([]);
	});

	it("runs checks and kills a command that times out", async () => {
		const dir = mkdtempSync(join(tmpdir(), "baton-run-"));
		const [pass, fail, slow] = await runChecks(dir, [
			{ kind: "a", command: "echo fine" },
			{ kind: "b", command: "echo 'error: broken' && exit 3" },
			{ kind: "c", command: "sleep 5" },
		], 1_000);
		expect(pass).toMatchObject({ passed: true, exitCode: 0 });
		expect(fail).toMatchObject({ passed: false, exitCode: 3 });
		expect(fail!.output).toContain("error: broken");
		expect(slow).toMatchObject({ passed: false, timedOut: true });
	});
});
