import { describe, expect, it } from "vitest";
import { addUsage, budgetLevel, spendOf } from "../src/budget.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { recordHelperTurn, runStopReason, speculationDecision, startRun } from "../src/run.ts";

const read = (id: string, path = "a.ts") => ({ id, name: "read", args: { path } });
const ok = (id: string, text = "x") => ({ id, isError: false, text });
const stopInput = { now: 0, turnHadToolCalls: true, budget: "ok" as const };

describe("speculative run stop rules", () => {
	it("runs to the step limit; a red check does not end it", () => {
		const run = startRun(1, 0, { steps: 2 }, { tree: "abc" });
		recordHelperTurn(run, [{ id: "t", name: "bash", args: { command: "npm test" } }], [{ id: "t", isError: true, text: "FAIL a.test.ts" }], new Map());
		expect(runStopReason(run, DEFAULT_CONFIG, stopInput)).toBeUndefined();
		recordHelperTurn(run, [read("r")], [ok("r")], new Map());
		expect(runStopReason(run, DEFAULT_CONFIG, stopInput)).toBe("step limit (2) reached");
	});

	it("stops when the helper stops, repeats itself, is blocked, runs out of time or budget", () => {
		const run = startRun(1, 0, { steps: 10 }, {});
		expect(runStopReason(run, DEFAULT_CONFIG, { ...stopInput, turnHadToolCalls: false })).toBe("the helper stopped calling tools");
		for (const id of ["a", "b", "c"]) recordHelperTurn(run, [read(id)], [ok(id, "same")], new Map());
		expect(runStopReason(run, DEFAULT_CONFIG, stopInput)).toMatch(/repeated the same call 3 times/);
		expect(runStopReason(startRun(2, 0, { steps: 10 }, {}), DEFAULT_CONFIG, { ...stopInput, now: DEFAULT_CONFIG.maxRunMs })).toMatch(/time limit/);
		expect(runStopReason(startRun(3, 0, { steps: 10 }, {}), DEFAULT_CONFIG, { ...stopInput, budget: "wrapUp" })).toMatch(/budget/);
		const blocked = startRun(4, 0, { steps: 10 }, {});
		recordHelperTurn(blocked, [read("w")], [], new Map([["w", "overwrites the existing file a.ts"]]));
		expect(runStopReason(blocked, DEFAULT_CONFIG, stopInput)).toMatch(/guardrail blocked read: overwrites/);
		expect(blocked.calls[0]!.outcome.status).toBe("error");
	});
});

describe("starting a run", () => {
	const leadCalls = [read("l")];
	const base = { leadCalls, cooldownLeft: 0, budget: "ok" as const };
	it("needs tool calls, no cooldown, budget and Jev's probability above the threshold", () => {
		expect(speculationDecision({ ...base, probability: 0.9 }, DEFAULT_CONFIG).start).toBe(true);
		expect(speculationDecision({ ...base, probability: 0.5 }, DEFAULT_CONFIG).start).toBe(false);
		expect(speculationDecision({ ...base, leadCalls: [] }, DEFAULT_CONFIG).start).toBe(false);
		expect(speculationDecision({ ...base, cooldownLeft: 1, probability: 0.99 }, DEFAULT_CONFIG).start).toBe(false);
		expect(speculationDecision({ ...base, budget: "wrapUp", probability: 0.99 }, DEFAULT_CONFIG).start).toBe(false);
		expect(speculationDecision({ ...base, leadCalls: [{ id: "x", name: "baton_rollback", args: {} }] }, DEFAULT_CONFIG).start).toBe(false);
		expect(speculationDecision(base, { ...DEFAULT_CONFIG, speculate: false }).start).toBe(false);
	});
	it("without Jev the lead's tool calls are enough", () => {
		expect(speculationDecision(base, DEFAULT_CONFIG)).toEqual({ start: true, reason: "Jev unavailable; the lead's turn had tool calls" });
	});
});

describe("budget", () => {
	it("uses reported costs and keeps room for the lead's wrap-up", () => {
		let rows = addUsage({}, "anthropic/claude-opus-5.5", { cost: { total: 0.2 } });
		rows = addUsage(rows, "z-ai/glm-5.3-flash", { cost: { total: 0.1 } });
		const spend = spendOf(rows, DEFAULT_CONFIG.helper, 1, 0.05);
		expect(spend).toMatchObject({ lead: 0.2, helper: 0.1, total: 0.35000000000000003, largestLeadTurn: 0.2 });
		expect(budgetLevel(spend, 0, 0.25)).toBe("unlimited");
		expect(budgetLevel(spend, 2, 0.25)).toBe("ok");
		expect(budgetLevel(spend, 0.7, 0.25)).toBe("wrapUp");
		expect(budgetLevel(spend, 0.3, 0.25)).toBe("exhausted");
	});
});
