import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectChanges, type FinishedRun, rememberOriginal, startRun, undoRun } from "../src/run.ts";

function project() {
	const cwd = mkdtempSync(join(tmpdir(), "baton-run-"));
	mkdirSync(join(cwd, "src"));
	writeFileSync(join(cwd, "src/a.ts"), "a1\n");
	writeFileSync(join(cwd, "src/b.ts"), "b1\n");
	return cwd;
}

const finish = (run: ReturnType<typeof startRun>, cwd: string): FinishedRun => ({ number: run.number, stopReason: "done", turns: 1, callCount: 0, changes: collectChanges(run, cwd), undone: new Set() });

describe("run changes and undo", () => {
	it("keeps the first original, ignores reads and unchanged files", () => {
		const cwd = project();
		const run = startRun(1, 0);
		rememberOriginal(run, cwd, { name: "edit", args: { path: "src/a.ts" } });
		writeFileSync(join(cwd, "src/a.ts"), "a2\n");
		rememberOriginal(run, cwd, { name: "edit", args: { path: "./src/a.ts" } });
		rememberOriginal(run, cwd, { name: "read", args: { path: "src/b.ts" } });
		rememberOriginal(run, cwd, { name: "write", args: { path: "@src/b.ts" } });
		rememberOriginal(run, cwd, { name: "write", args: { path: "src/new.ts" } });
		writeFileSync(join(cwd, "src/new.ts"), "new\n");
		const changes = collectChanges(run, cwd);
		expect(changes.map((change) => [change.path, change.before?.toString(), change.after?.toString()])).toEqual([
			["src/a.ts", "a1\n", "a2\n"],
			["src/new.ts", undefined, "new\n"],
		]);
	});

	it("undoes selected or all files, skips files changed after the run", () => {
		const cwd = project();
		const run = startRun(1, 0);
		for (const path of ["src/a.ts", "src/b.ts", "src/new.ts"]) rememberOriginal(run, cwd, { name: "write", args: { path } });
		writeFileSync(join(cwd, "src/a.ts"), "a2\n");
		writeFileSync(join(cwd, "src/b.ts"), "b2\n");
		writeFileSync(join(cwd, "src/new.ts"), "new\n");
		const finished = finish(run, cwd);

		expect(undoRun(finished, cwd, ["src/a.ts", "src/zzz.ts"])).toMatchObject({ restored: ["src/a.ts"], notInRun: ["src/zzz.ts"] });
		expect(readFileSync(join(cwd, "src/a.ts"), "utf8")).toBe("a1\n");

		writeFileSync(join(cwd, "src/b.ts"), "b3 by the lead\n");
		expect(undoRun(finished, cwd)).toMatchObject({ restored: [], deleted: ["src/new.ts"], changedLater: ["src/b.ts"], alreadyUndone: ["src/a.ts"] });
		expect(existsSync(join(cwd, "src/new.ts"))).toBe(false);
		expect(readFileSync(join(cwd, "src/b.ts"), "utf8")).toBe("b3 by the lead\n");
	});
});
