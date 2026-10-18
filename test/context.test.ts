import { describe, expect, it } from "vitest";
import { ALERT_TYPE, type ContextMessage, projectSystemPrompt, viewFor } from "../src/context.ts";
import { followerSystemNote, leadSystemNote } from "../src/notes.ts";

const HELPER = "openrouter/z-ai/glm-5.3-flash";
const alert = (content: string, timestamp: number) => ({ role: "custom", customType: ALERT_TYPE, content, timestamp });

const transcript: ContextMessage[] = [
	{ role: "user", content: "build tetris", timestamp: 1 },
	{
		role: "assistant",
		model: "anthropic/claude-opus-5.5",
		content: [
			{ type: "thinking", thinking: "LEAD THINKING", thinkingSignature: "sig-1" },
			{ type: "toolCall", id: "lead-1" },
		],
		timestamp: 2,
	},
	{ role: "toolResult", toolCallId: "lead-1", content: [{ type: "text", text: "LEAD RESULT" }], timestamp: 3 },
	{
		role: "assistant",
		model: "z-ai/glm-5.3-flash",
		content: [
			{ type: "thinking", thinking: "FOLLOWER THINKING" },
			{ type: "text", text: "I updated the board." },
			{ type: "toolCall", id: "helper-1" },
		],
		timestamp: 4,
	},
	{ role: "toolResult", toolCallId: "helper-1", content: [{ type: "text", text: "OLD HELPER RESULT" }], timestamp: 5 },
	{ role: "user", content: "use canvas instead", timestamp: 6 },
	{
		role: "assistant",
		model: "z-ai/glm-5.3-flash",
		content: [
			{ type: "thinking", thinking: "SECOND FOLLOWER THINKING" },
			{ type: "toolCall", id: "helper-2" },
		],
		timestamp: 7,
	},
	{ role: "toolResult", toolCallId: "helper-2", content: [{ type: "text", text: "CURRENT HELPER RESULT" }], timestamp: 8 },
	alert("ALERT ONE", 9),
	{ role: "assistant", model: "anthropic/claude-opus-5.5", content: [{ type: "toolCall", id: "lead-2" }], timestamp: 10 },
	{ role: "toolResult", toolCallId: "lead-2", content: [], timestamp: 11 },
	{
		role: "assistant",
		model: "z-ai/glm-5.3-flash",
		content: [{ type: "thinking", thinking: "THIRD FOLLOWER THINKING" }, { type: "toolCall", id: "helper-3" }],
		timestamp: 12,
	},
	{ role: "toolResult", toolCallId: "helper-3", content: [{ type: "text", text: "LATER HELPER RESULT" }], timestamp: 13 },
	alert("ALERT TWO", 14),
];

describe("context views", () => {
	it("the lead sees the alert in place of follower tool work, and keeps a user message beside it", () => {
		const view = viewFor(transcript, HELPER, "lead");
		expect(view.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user", "custom", "assistant", "toolResult", "custom"]);
		expect(JSON.stringify(view)).toContain("LEAD THINKING");
		expect(JSON.stringify(view)).toContain("LEAD RESULT");
		expect(JSON.stringify(view)).toContain("use canvas instead");
		expect(JSON.stringify(view)).toContain("ALERT ONE");
		expect(JSON.stringify(view)).toContain("ALERT TWO");
		expect(JSON.stringify(view)).not.toMatch(/FOLLOWER THINKING|HELPER RESULT|I updated the board/);
		expect(view[3]).toMatchObject({ role: "user", content: "use canvas instead" });
		expect(view[4]).toMatchObject({ content: "ALERT ONE" });
	});

	it("the follower sees lead thinking and real tool results, and omits alerts and its own thinking", () => {
		const view = viewFor(transcript, HELPER, "follower");
		expect(JSON.stringify(view)).not.toMatch(/ALERT ONE|ALERT TWO/);
		expect(JSON.stringify(view)).not.toMatch(/FOLLOWER THINKING/);
		expect(view[1]?.content).toEqual([
			{ type: "thinking", thinking: "LEAD THINKING", thinkingSignature: "sig-1" },
			{ type: "toolCall", id: "lead-1" },
		]);
		expect(JSON.stringify(view)).toContain("OLD HELPER RESULT");
		expect(JSON.stringify(view)).toContain("CURRENT HELPER RESULT");
		expect(JSON.stringify(view)).toContain("LATER HELPER RESULT");
		expect(JSON.stringify(view)).toContain("use canvas instead");
		expect(JSON.stringify(view)).toContain("I updated the board.");
		const followerTurn = view.find((message) => message.role === "assistant" && message.model === "z-ai/glm-5.3-flash");
		expect(followerTurn?.content).toEqual([
			{ type: "text", text: "I updated the board." },
			{ type: "toolCall", id: "helper-1" },
		]);
	});

	it("a later follower view still omits every alert", () => {
		const secondRun = viewFor(transcript, HELPER, "follower");
		expect(secondRun.some((message) => message.customType === ALERT_TYPE)).toBe(false);
		expect(JSON.stringify(secondRun)).toContain("LATER HELPER RESULT");
		expect(JSON.stringify(secondRun)).not.toContain("THIRD FOLLOWER THINKING");
	});

	it("treats a non-openrouter helper id as the follower, so the lead sees the alert instead of that tool call", () => {
		const helper = "anthropic/claude-haiku-4-5";
		const messages: ContextMessage[] = [
			{
				role: "assistant",
				model: "claude-haiku-4-5",
				content: [
					{ type: "thinking", thinking: "FOLLOWER THINKING" },
					{ type: "toolCall", id: "h1" },
				],
			},
			{ role: "toolResult", toolCallId: "h1", content: [{ type: "text", text: "HELPER RESULT" }] },
			alert("ALERT", 2),
		];
		const view = viewFor(messages, helper, "lead");
		expect(view.map((message) => message.role)).toEqual(["custom"]);
		expect(JSON.stringify(view)).toContain("ALERT");
		expect(JSON.stringify(view)).not.toMatch(/FOLLOWER THINKING|HELPER RESULT|"h1"/);
	});

	it("keeps messages from other models, e.g. before Baton was enabled", () => {
		const view = viewFor([{ role: "assistant", model: "anthropic/claude-sonnet-5", content: [], timestamp: 1 }], HELPER, "lead");
		expect(view).toHaveLength(1);
	});

	it("puts the role section on the system prompt without replacing the base text", () => {
		const base: ContextMessage[] = [{ role: "system", content: "BASE PROMPT", sections: { identity: "You are pi." } }];
		const lead = projectSystemPrompt(base, leadSystemNote());
		expect(lead[0]?.content).toBe("BASE PROMPT");
		expect(lead[0]?.sections).toEqual({ identity: "You are pi.", baton: leadSystemNote() });
		const follower = projectSystemPrompt(lead, followerSystemNote());
		expect(follower[0]?.sections?.baton).toBe(followerSystemNote());
		expect(follower[0]?.sections?.identity).toBe("You are pi.");
	});
});
