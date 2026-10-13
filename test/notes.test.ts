import { describe, expect, it } from "vitest";
import type { CheckResult } from "../src/checks.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { helperInstruction, LEAD_SYSTEM_NOTE, renderFinalChecksNote, renderRunNote } from "../src/notes.ts";
import { recordHelperTurn, startRun } from "../src/run.ts";

const failingBuild: CheckResult = { kind: "build", command: "npm run -s build", passed: false, exitCode: 1, timedOut: false, output: "vite v7\nerror: JSX syntax extension is not enabled\n", durationMs: 900 };
const passingTest: CheckResult = { kind: "test", command: "npm test --silent", passed: true, exitCode: 0, timedOut: false, output: "", durationMs: 500 };

function sampleRun() {
	const run = startRun(3, 0, { steps: 6 }, { tree: "start123" });
	recordHelperTurn(
		run,
		[
			{ id: "r", name: "read", args: { path: "src/model.ts" } },
			{ id: "e", name: "edit", args: { path: "vite.config.ts", oldText: "react()", newText: "" } },
			{ id: "t", name: "bash", args: { command: "npm test 2>&1 | tail -3" } },
		],
		[
			{ id: "r", isError: false, text: "export const MODEL_SOURCE = 1;" },
			{ id: "e", isError: false, text: "Edited vite.config.ts" },
			{ id: "t", isError: false, text: "FAIL src/game.test.ts\n1 failed" },
		],
		new Map(),
	);
	return run;
}

describe("run note for the lead", () => {
	it("is written from facts: attribution, checkpoint, honest outcomes, diff, harness checks, reads verbatim", () => {
		const note = renderRunNote(sampleRun(), { stopReason: "the helper stopped calling tools", changedFiles: [{ status: "modified", path: "vite.config.ts" }], diff: "-  plugins: [react()],\n+  plugins: [],", checks: [passingTest, failingBuild] }, DEFAULT_CONFIG, "end456");
		expect(note).toMatch(/^\[Baton harness\] Speculative run #3 — performed by the helper model \(glm-5\.3-flash\), not by you\./);
		expect(note).toContain("baton_rollback({run: 3})");
		expect(note).toContain("git diff start123 end456");
		expect(note).toMatch(/npm test 2>&1 \| tail -3` → UNRELIABLE — exit 0 comes from the last command of a pipe/);
		expect(note).toContain("- modified vite.config.ts");
		expect(note).toContain("+  plugins: [],");
		expect(note).toMatch(/Checks run by the harness after the run \(SOME FAILED\)/);
		expect(note).toMatch(/build: `npm run -s build` → FAIL \(exit 1\)\n[\s\S]*JSX syntax extension/);
		expect(note).toMatch(/--- read src\/model\.ts ---\nexport const MODEL_SOURCE = 1;/);
		expect(note).toMatch(/You are responsible for this work/);
	});

	it("never includes the helper's prose", () => {
		const run = sampleRun();
		const note = renderRunNote(run, { stopReason: "x", changedFiles: [], diff: "" }, DEFAULT_CONFIG);
		expect(note).not.toMatch(/all checks pass|GREEN/);
		expect(note).toContain("the run changed no files");
	});

	it("full transcript mode passes every output verbatim", () => {
		const note = renderRunNote(sampleRun(), { stopReason: "x", changedFiles: [], diff: "" }, { ...DEFAULT_CONFIG, transcript: "full" });
		expect(note).toContain("Full outputs of the helper's calls (verbatim)");
		expect(note).toContain("--- edit vite.config.ts ---\nEdited vite.config.ts");
		expect(note).toContain("FAIL src/game.test.ts\n1 failed");
	});

	it("explains a missing checkpoint and respects the size cap", () => {
		const run = startRun(1, 0, { steps: 6 }, { unavailableReason: "not a git repository" });
		recordHelperTurn(run, [{ id: "r", name: "read", args: { path: "big.ts" } }], [{ id: "r", isError: false, text: "y".repeat(50_000) }], new Map());
		const note = renderRunNote(run, { stopReason: "x", diffUnavailableReason: "no checkpoint" }, { ...DEFAULT_CONFIG, noteChars: 5_000, readChars: 100 });
		expect(note).toMatch(/Checkpoint: none \(not a git repository\)/);
		expect(note).toMatch(/omitted: read budget exhausted/);
		expect(note.length).toBeLessThanOrEqual(5_000);
	});
});

describe("other harness texts", () => {
	it("the lead's system note explains speculation, rollback and final verification", () => {
		expect(LEAD_SYSTEM_NOTE).toMatch(/speculative run/);
		expect(LEAD_SYSTEM_NOTE).toMatch(/baton_rollback/);
		expect(LEAD_SYSTEM_NOTE).toMatch(/You own the final verification/);
	});
	it("the helper instruction states the limits of the run", () => {
		const text = helperInstruction(startRun(2, 0, { steps: 6 }, {}), ["read src/a.ts"]);
		expect(text).toMatch(/Speculative run #2/);
		expect(text).toMatch(/up to 6 turns/);
		expect(text).toMatch(/Do not rewrite or delete existing files and tests/);
	});
	it("the final checks note lists failures", () => {
		const text = renderFinalChecksNote([passingTest, failingBuild], 1, 2);
		expect(text).toMatch(/round 1 of 2\)\. 1 of 2 failed/);
		expect(text).toMatch(/JSX syntax extension/);
	});
});
