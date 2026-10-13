import { describe, expect, it } from "vitest";
import { extractJson, parseAdvisorReply, renderPlan } from "../src/schema.ts";

const good = {
	assessment: "close",
	verdict: "course_correct",
	facts_corrected: [{ claim: "tests pass", truth: "2 fail", evt: [12] }],
	plan: [{ id: "S1", action: "fix a.ts", done_when: "npm test green", avoid: "mocking" }],
	do_not_retry: ["approach X"],
	test_cmd: "npm test",
};

describe("advisor schema", () => {
	it("accepts a valid reply inside fences and prose", () => {
		const r = parseAdvisorReply(`Sure!\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``);
		expect(r.ok).toBe(true);
	});
	it("rejects a bad verdict and a missing done_when", () => {
		expect(parseAdvisorReply(JSON.stringify({ ...good, verdict: "great" })).ok).toBe(false);
		const r = parseAdvisorReply(JSON.stringify({ ...good, plan: [{ id: "S1", action: "x" }] }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
		expect(parseAdvisorReply("no json here").ok).toBe(false);
	});
	it("truncates plans longer than 7 steps", () => {
		const plan = Array.from({ length: 9 }, (_, i) => ({ id: `S${i}`, action: "a", done_when: "d" }));
		const r = parseAdvisorReply(JSON.stringify({ ...good, plan }));
		expect(r.ok && r.reply.plan.length).toBe(7);
		expect(r.ok && r.truncated).toBe(true);
	});
	it("extractJson handles braces in strings", () => {
		expect(extractJson('x {"a":"}{","b":{"c":1}} y')).toEqual({ a: "}{", b: { c: 1 } });
	});
	it("renders a plan block", () => {
		const r = parseAdvisorReply(JSON.stringify(good));
		const t = r.ok ? renderPlan(r.reply, "baton_help") : "";
		expect(t).toContain('verdict="course_correct"');
		expect(t).toContain("done when: npm test green");
		expect(t).toContain("Test command: npm test");
	});
});
