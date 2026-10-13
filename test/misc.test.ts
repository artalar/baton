import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, deepMerge, parseModelRef } from "../src/pi/config.ts";
import type { JournalEvent } from "../src/core/journal.ts";
import { timelineEvents } from "../src/core/pack/collect.ts";
import { repoMap } from "../src/core/repo.ts";
import { pickFirstKept, resetSummary } from "../src/pi/reset.ts";

const ev = (evt: number, importance: 0 | 1 | 2 | 3): JournalEvent => ({ evt, ts: "", turn: 0, kind: "tool_call", tool: "bash", importance });

describe("config", () => {
	it("merges overrides and drops secret-looking keys", () => {
		const c = deepMerge(DEFAULT_CONFIG, { advisor: "anthropic/claude-opus-5.5", apiKey: "sk-x", triggers: { remindEvery: 0 } });
		expect(c.advisor).toBe("anthropic/claude-opus-5.5");
		expect(c.triggers.remindEvery).toBe(0);
		expect(c.triggers.sameErrorCount).toBe(3);
		expect((c as unknown as Record<string, unknown>).apiKey).toBeUndefined();
	});
	it("parses provider/id with slashes in the id", () => {
		expect(parseModelRef("openrouter/z-ai/glm-5.3-flash")).toEqual({ provider: "openrouter", id: "z-ai/glm-5.3-flash" });
		expect(parseModelRef("nope")).toBeUndefined();
	});
});

describe("timeline", () => {
	it("keeps importance 3 and 2, drops 1 and 0 (deterministic; the Jev judge was removed)", () => {
		expect(timelineEvents([ev(1, 3), ev(2, 2), ev(3, 1), ev(4, 0)]).map((e) => e.evt)).toEqual([1, 2]);
	});
});

describe("reset", () => {
	const entries = [
		{ id: "u1", type: "message", message: { role: "user" } },
		{ id: "a1", type: "message", message: { role: "assistant" } },
		{ id: "t1", type: "message", message: { role: "toolResult" } },
		{ id: "a2", type: "message", message: { role: "assistant" } },
		{ id: "a3", type: "message", message: { role: "assistant" } },
	];
	it("keeps the last N assistant turns", () => {
		expect(pickFirstKept(entries, 2)).toBe("a2");
		expect(pickFirstKept(entries, 10)).toBe("a1");
		expect(pickFirstKept(entries, 0)).toBeNull();
	});
	it("summary has task and plan", () => {
		const s = resetSummary({ task: "T", plan: "<advisor_plan>", userPrompts: ["T", "more"] });
		expect(s).toContain("T");
		expect(s).toContain("more");
		expect(s).toContain("<advisor_plan>");
		expect(s).toContain("baton_recall");
	});
});

describe("repoMap", () => {
	it("lists files with exported symbols", () => {
		const m = repoMap(["a.ts", "b.md"], (p) => (p === "a.ts" ? "export function foo() {}\nconst x = 1\nexport class Bar {}" : ""), 1000);
		expect(m).toContain("a.ts: foo, Bar");
		expect(m).toContain("b.md");
	});
});
