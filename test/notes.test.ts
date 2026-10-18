import { describe, expect, it } from "vitest";
import { ALERT_INTRO, followerSystemNote, leadSystemNote, renderAlert } from "../src/notes.ts";
import type { RunCall } from "../src/run.ts";

describe("speculative alert", () => {
	it("lists every tool call's input and output and nothing else", () => {
		const calls: RunCall[] = [
			{ id: "1", name: "read", args: { path: "src/a.ts" }, output: "READ BODY" },
			{ id: "2", name: "bash", args: { command: "npm test" }, isError: true, output: "FAIL clears rows\nTests: 1 failed" },
		];
		expect(renderAlert(calls)).toBe(
			`${ALERT_INTRO}\n1. read\ninput: {"path":"src/a.ts"}\noutput: READ BODY\n2. bash\ninput: {"command":"npm test"}\noutput: FAIL clears rows\nTests: 1 failed`,
		);
	});

	it("is only the intro when the follower made no tool calls", () => {
		expect(renderAlert([])).toBe(ALERT_INTRO);
	});

	it("tells the lead and the follower in a few sentences, with no handoff ritual", () => {
		const lead = leadSystemNote();
		const follower = followerSystemNote();
		expect(lead).toContain("cheaper model may continue");
		expect(lead).toContain("speculative automation alert");
		expect(follower).toContain("Continue the work already in the context");
		expect(follower).toContain("stop without a tool call");
		for (const text of [lead, follower, ALERT_INTRO]) {
			expect(text).not.toMatch(/Helper:|scratch|baton_undo|git diff|git status/);
		}
	});
});
