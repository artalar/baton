import { describe, expect, it } from "vitest";
import { HELPER_INSTRUCTION_TYPE, LEAD_NOTE_TYPE, viewFor } from "../src/context.ts";

const HELPER = "openrouter/z-ai/glm-5.3-flash";
const transcript = [
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
	{ role: "custom", customType: HELPER_INSTRUCTION_TYPE, content: "OLD INSTRUCTION", timestamp: 4 },
	{ role: "assistant", model: "z-ai/glm-5.3-flash", content: [{ type: "toolCall", id: "helper-1" }], timestamp: 5 },
	{ role: "toolResult", toolCallId: "helper-1", content: [{ type: "text", text: "OLD HELPER RESULT" }], timestamp: 6 },
	{ role: "custom", customType: LEAD_NOTE_TYPE, content: "RUN NOTE", timestamp: 7 },
	{ role: "assistant", model: "anthropic/claude-opus-5.5", content: [{ type: "toolCall", id: "lead-2" }], timestamp: 8 },
	{ role: "toolResult", toolCallId: "lead-2", content: [], timestamp: 9 },
	{ role: "custom", customType: HELPER_INSTRUCTION_TYPE, content: "CURRENT INSTRUCTION", timestamp: 10 },
	{ role: "assistant", model: "z-ai/glm-5.3-flash", content: [{ type: "toolCall", id: "helper-2" }], timestamp: 11 },
	{ role: "toolResult", toolCallId: "helper-2", content: [{ type: "text", text: "CURRENT HELPER RESULT" }], timestamp: 12 },
];

describe("context views", () => {
	it("the lead sees its own turns and harness notes, never helper turns or instructions", () => {
		const view = JSON.stringify(viewFor(transcript, HELPER));
		expect(view).toContain("LEAD RESULT");
		expect(view).toContain("RUN NOTE");
		expect(view).not.toMatch(/INSTRUCTION|HELPER RESULT/);
	});

	it("the helper sees the lead's view plus only its current run", () => {
		const view = JSON.stringify(viewFor(transcript, HELPER, 10));
		expect(view).toContain("RUN NOTE");
		expect(view).toContain("CURRENT INSTRUCTION");
		expect(view).toContain("CURRENT HELPER RESULT");
		expect(view).not.toContain("OLD INSTRUCTION");
		expect(view).not.toContain("OLD HELPER RESULT");
	});

	it("extracts lead thinking to text for the helper and restores it when switching back to the lead", () => {
		const helperView = viewFor(transcript, HELPER, 10);
		expect(helperView[1]?.content).toEqual([
			{ type: "text", text: "LEAD THINKING" },
			{ type: "toolCall", id: "lead-1" },
		]);

		const restoredFromTranscript = viewFor(transcript, HELPER);
		expect(restoredFromTranscript[1]?.content).toEqual([
			{ type: "thinking", thinking: "LEAD THINKING", thinkingSignature: "sig-1" },
			{ type: "toolCall", id: "lead-1" },
		]);

		const restoredFromHelperView = viewFor(helperView, HELPER);
		expect(restoredFromHelperView[1]?.content).toEqual([
			{ type: "thinking", thinking: "LEAD THINKING", thinkingSignature: "sig-1" },
			{ type: "toolCall", id: "lead-1" },
		]);
	});

	it("keeps messages from other models, e.g. before Baton was enabled", () => {
		const view = viewFor([{ role: "assistant", model: "anthropic/claude-sonnet-5", content: [], timestamp: 1 }], HELPER);
		expect(view).toHaveLength(1);
	});
});
