import { describe, expect, it } from "vitest";
import { buildPack, type PackInput } from "../src/pack.ts";
import { estimateTokens } from "../src/util.ts";

const base: PackInput = { kind: "review", task: "Fix the bug", userPrompts: [{ evt: 1, text: "Fix the bug" }, { evt: 5, text: "also add tests" }] };

describe("buildPack", () => {
	it("includes task, prompts verbatim and the review artefacts", () => {
		const p = buildPack({ ...base, diffStat: "1 file", diff: "+a", changedFiles: [{ path: "a.ts", content: "x" }] }, 40_000);
		expect(p.text).toContain("## TASK (verbatim)\nFix the bug");
		expect(p.text).toContain("[evt#5] also add tests");
		expect(p.text).toContain("## GIT DIFF\n+a");
		expect(p.text).toContain("LAST TEST RUN");
		expect(p.text).toContain('"verdict"');
		expect(p.overBudget).toBe(false);
	});
	it("fits a huge pack into the budget, cutting files before the diff and never the prompts", () => {
		const p = buildPack({ ...base, diff: "d".repeat(100_000), changedFiles: [{ path: "a", content: "f".repeat(200_000) }] }, 10_000);
		expect(p.tokens).toBeLessThanOrEqual(10_500);
		expect(p.sections.find((s) => s.title === "CHANGED FILES")?.clipped).toBe(true);
		expect(p.sections.find((s) => s.title === "USER PROMPTS (verbatim)")?.clipped).toBe(false);
		expect(p.text).toContain("also add tests");
	});
	it("help pack carries hypothesis, attempts and verbatim calls", () => {
		const event = { evt: 7, ts: "", turn: 1, kind: "tool_call" as const, tool: "bash", argsDigest: "command=npm test", exit: 1, errSig: "Error: boom" };
		const p = buildPack({ ...base, kind: "help", hypothesis: "H", attempts: ["tried A"], lastCalls: [{ event, args: "command=npm test", output: "Error: boom\nfull" }] }, 40_000);
		expect(p.text).toContain("EXECUTOR HYPOTHESIS");
		expect(p.text).toContain("- tried A");
		expect(p.text).toContain("Error: boom\nfull");
		expect(p.text).not.toContain("GIT DIFF\n");
	});
	it("plan pack has rules and repo map", () => {
		const p = buildPack({ ...base, kind: "plan", agentsMd: "use pnpm", repoMap: "src/a.ts: foo" }, 40_000);
		expect(p.text).toContain("use pnpm");
		expect(p.text).toContain("src/a.ts: foo");
		expect(p.tokens).toBe(estimateTokens(p.text));
	});
});
