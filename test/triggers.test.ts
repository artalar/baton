import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { commitGate, evaluate, initialTriggerState, isGitCommit, onAdvisor, onToolResult, type TriggerState } from "../src/triggers.ts";

const cfg = DEFAULT_CONFIG.triggers;
const run = (s: TriggerState, n: number, sig: string | null = null) => {
	for (let i = 0; i < n; i++) s = onToolResult(s, "bash", sig, false);
	return s;
};

describe("triggers", () => {
	it("nudges help after the same error 3 times, once per signature", () => {
		let s = run(initialTriggerState(), 2, "E");
		expect(evaluate(s, cfg, null).nudge).toBeUndefined();
		s = run(s, 1, "E");
		const r = evaluate(s, cfg, null);
		expect(r.nudge).toMatchObject({ kind: "same_error", count: 3 });
		expect(evaluate(run(r.state, 1, "E"), cfg, null).nudge?.kind).not.toBe("same_error");
	});
	it("nudges at 60% context once, respecting cooldown", () => {
		let s = run(initialTriggerState(), 6);
		expect(evaluate(s, cfg, 0.59).nudge).toBeUndefined();
		const r = evaluate(s, cfg, 0.6);
		expect(r.nudge?.kind).toBe("context");
		s = run(r.state, 10);
		expect(evaluate(s, cfg, 0.9).nudge).toBeUndefined();
	});
	it("cooldown suppresses context nudges right after an advisor call", () => {
		let s = run(initialTriggerState(), 10);
		s = onAdvisor(onToolResult(s, "baton_plan", null, false), "plan", "replan");
		s = run(s, 2);
		expect(evaluate(s, cfg, 0.7).nudge).toBeUndefined();
		expect(evaluate(run(s, 3), cfg, 0.7).nudge?.kind).toBe("context");
	});
	it("reminds after 25 calls without an advisor", () => {
		const s = run(initialTriggerState(), 25);
		const r = evaluate(s, cfg, null);
		expect(r.nudge?.kind).toBe("reminder");
		expect(evaluate(run(r.state, 1), cfg, null).nudge).toBeUndefined();
	});
	it("gates git commit until a review passed; new edits revoke it", () => {
		let s = initialTriggerState();
		expect(commitGate("git commit -m x", s, cfg)?.block).toBe(true);
		expect(commitGate("git status", s, cfg)).toBeUndefined();
		s = onAdvisor(s, "review", "course_correct");
		expect(commitGate("cd a && git commit", s, cfg)?.block).toBe(true);
		s = onAdvisor(s, "review", "done");
		expect(commitGate("git commit -m x", s, cfg)).toBeUndefined();
		s = onToolResult(s, "edit", null, true);
		expect(commitGate("git commit -m x", s, cfg)?.block).toBe(true);
		expect(commitGate("git commit", initialTriggerState(), { ...cfg, reviewBeforeCommit: false })).toBeUndefined();
	});
	it("detects git commit variants", () => {
		expect(isGitCommit("git -c user.name=a commit -m x")).toBe(true);
		expect(isGitCommit("echo git commits")).toBe(false);
		expect(isGitCommit("git log --grep commit")).toBe(false);
	});
});
