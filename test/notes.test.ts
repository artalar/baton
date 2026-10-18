import { describe, expect, it } from "vitest";
import { helperInstruction, leadRequestsHelper, leadSystemNote, renderRunNote, renderUndoResult } from "../src/notes.ts";
import type { RunCall } from "../src/run.ts";

const base = { runNumber: 3, helperModel: "openrouter/z-ai/glm-5.3-flash", stopReason: "the helper ended its turn without tool calls", turns: 2, noteChars: 80_000 };

describe("run note", () => {
	it("reports calls, verbatim reads once, output tails of other calls, and the diff", () => {
		const calls: RunCall[] = [
			{ id: "1", name: "read", args: { path: "src/a.ts" }, output: "READ BODY" },
			{ id: "2", name: "read", args: { path: "src/a.ts" }, output: "READ BODY" },
			{ id: "3", name: "edit", args: { path: "src/a.ts", edits: [] }, output: "Edited" },
			{ id: "4", name: "bash", args: { command: "npm test" }, isError: true, output: "FAIL clears rows\nTests: 1 failed" },
		];
		const note = renderRunNote({ ...base, calls, changes: [{ path: "src/a.ts", before: Buffer.from("one\n"), after: Buffer.from("two\n") }, { path: "src/new.ts", before: undefined, after: Buffer.from("x\n") }] });
		expect(note).toMatch(/^\[Baton\] Speculative run #3 by the helper model \(glm-5\.3-flash\), not by you/);
		expect(note).toMatch(/It stopped because the helper ended its turn without tool calls: 2 turn\(s\), 4 tool call\(s\)/);
		expect(note).toMatch(/1\. read src\/a\.ts → ok \(output below\)/);
		expect(note).toMatch(/4\. bash `npm test` → error\n {3}FAIL clears rows\n {3}Tests: 1 failed/);
		expect(note).toContain("- modified src/a.ts (+1 −1)");
		expect(note).toContain("- created src/new.ts (+1 −0)");
		expect(note).toMatch(/-one\n\+two/);
		expect(note).toContain("baton_undo({run: 3})");
		expect(note).toContain("Continue from here: keep the run, fix it, or undo it.");
		expect(note.match(/READ BODY/g)).toHaveLength(1);
	});

	it("omits reads before clipping the diff when the note is too large", () => {
		const calls: RunCall[] = [{ id: "1", name: "read", args: { path: "big.ts" }, output: "x".repeat(5_000) }];
		const note = renderRunNote({ ...base, noteChars: 3_000, calls, changes: [{ path: "a.ts", before: Buffer.from("1\n"), after: Buffer.from("2\n") }] });
		expect(note).toMatch(/--- read big\.ts ---\n\[omitted — read it yourself\]/);
		expect(note).toMatch(/\+2/);
		expect(note).toMatch(/1\. read big\.ts → ok$/m);
	});

	it("tells the lead to continue when the run changed no files", () => {
		const note = renderRunNote({ ...base, calls: [{ id: "1", name: "read", args: { path: "a.ts" }, output: "x" }], changes: [] });
		expect(note).toContain("Files changed with edit/write: none.");
		expect(note).toContain("This run changed no files. Continue the task.");
		expect(note).not.toContain("keep the run, fix it, or undo it");
		expect(note).not.toContain("baton_undo");
	});

	it("lists paths changed outside edit/write without offering to undo them", () => {
		const note = renderRunNote({
			...base,
			calls: [{ id: "1", name: "bash", args: { command: "printf x > side.txt" }, output: "ok" }],
			changes: [],
			outsidePaths: ["side.txt"],
		});
		expect(note).toContain("Paths changed outside edit/write (not undone):\n- side.txt");
		expect(note).toContain("Continue the task.");
		expect(note).not.toContain("baton_undo");
		expect(note).not.toContain("keep the run, fix it, or undo it");
		expect(note).not.toContain("This run changed no files");
	});

	it("starts a run from a Helper: line and describes that narrower job", () => {
		expect(leadRequestsHelper("Helper: run the typecheck")).toBe(true);
		expect(leadRequestsHelper("  Helper: run it")).toBe(true);
		expect(leadRequestsHelper("Done.\nHelper: read src/a.ts")).toBe(true);
		expect(leadRequestsHelper("I will ask the Helper: later")).toBe(false);
		expect(leadRequestsHelper("helper: run it")).toBe(false);
		const system = leadSystemNote(".pi/baton/scratch");
		expect(system).toContain('begins with "Helper:"');
		expect(system).toContain("Without that line the next turn is yours");
		expect(system).not.toContain("Do not redo or re-read");
		const instruction = helperInstruction(1, { leadFiles: [], scratchDir: ".pi/baton/scratch" });
		expect(instruction).toContain('latest "Helper:" request');
		expect(instruction).toContain("If there is no such request, stop with no tool calls");
		expect(instruction).not.toContain("obvious follow-up");
	});

	it("renders undo results", () => {
		expect(renderUndoResult(2, { restored: ["a.ts"], deleted: ["n.ts"], changedLater: ["b.ts"], alreadyUndone: [], notInRun: [] })).toBe(
			"baton_undo run #2: restored a.ts; deleted n.ts (created by the run); left b.ts as they are (changed after the run — fix them by hand).",
		);
	});
});
