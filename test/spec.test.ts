import { describe, expect, it } from "vitest";
import { type Call, DEFAULT_SWITCH, decideTurn, gateCall, initialSwitchState, shapeContext, specSteps, specSummary, type TurnInput } from "../src/pi/switch-core.ts";
import { SPEC_QUESTIONS } from "../src/pi/jev-policy.ts";

const cfg = { ...DEFAULT_SWITCH, spec: { ...DEFAULT_SWITCH.spec, enabled: true } };
const c = (id: string, name: string, args: Record<string, unknown> = {}): Call => ({ id, name, args });
let t = 0;
const turn = (p: Partial<TurnInput>): TurnInput => ({ turn: t++, now: 1000 + t, text: "", calls: [], results: [], empty: false, ...p });
const lead = () => {
	const s = initialSwitchState(0);
	s.phase = "lead";
	return s;
};

describe("0.13 speculative execution", () => {
	it("off by default; Jev question exists", () => {
		expect(DEFAULT_SWITCH.spec.enabled).toBe(false);
		expect(SPEC_QUESTIONS.more_calls).toBeDefined();
	});
	it("adaptive N: p ≥ 0.93 → 8, 0.8 ≤ p < 0.93 → 4, else 0", () => {
		expect(specSteps(0.97, cfg.spec)).toBe(8);
		expect(specSteps(0.85, cfg.spec)).toBe(4);
		expect(specSteps(0.5, cfg.spec)).toBe(0);
		expect(specSteps(undefined, cfg.spec)).toBe(0);
	});
	it("lead tool call + high p → spec; helper runs N steps without guardrails, then lead gets the summary", () => {
		const s = lead();
		const d = decideTurn(s, turn({ calls: [c("l1", "bash", { command: "npx vitest run" })], results: [{ id: "l1", isError: true, text: "FAIL src/a.test.ts\n1 failed" }], specP: 0.85 }), cfg);
		expect(d.to).toBe("spec");
		expect(s.specRun?.n).toBe(4);
		// no guardrails / policy in spec: even a write of a new file and baton tools pass
		expect(gateCall(s, c("w0", "write", { path: "new.ts" }), () => false)).toBeUndefined();
		decideTurn(s, turn({ calls: [c("h1", "read", { path: "src/a.ts" })], results: [{ id: "h1", isError: false, text: "export const a = 1" }] }), cfg);
		decideTurn(s, turn({ calls: [c("h2", "edit", { path: "src/a.ts" })], results: [{ id: "h2", isError: false, text: "ok" }] }), cfg);
		decideTurn(s, turn({ calls: [c("h3", "bash", { command: "npx vitest run" })], results: [{ id: "h3", isError: false, text: "Tests 3 passed" }] }), cfg);
		const back = decideTurn(s, { ...turn({ text: "fixed", calls: [c("h4", "bash", { command: "npx tsc --noEmit" })], results: [{ id: "h4", isError: false, text: "" }] }), diffStat: () => " src/a.ts | 2 +-" }, cfg);
		expect(back.to).toBe("lead");
		const txt = back.message!.text;
		expect(back.message!.audience).toBe("lead");
		expect(txt).toMatch(/^\[Baton harness\] To save your context, the harness speculatively continued/);
		expect(txt).toMatch(/4 step\(s\), 4 tool call\(s\)/);
		expect(txt).toMatch(/Files written\/edited by the helper: src\/a\.ts/);
		expect(txt).toMatch(/src\/a\.ts \| 2 \+-/);
		expect(txt).toMatch(/Last check run: `npx tsc --noEmit`/);
		expect(s.specCooldown).toBe(1);
	});
	it("helper stops early (no tool calls) → back to lead; cooldown: next lead turn is not speculated", () => {
		const s = lead();
		decideTurn(s, turn({ calls: [c("l1", "read", { path: "a" })], specP: 0.99 }), cfg);
		const back = decideTurn(s, turn({ text: "Task looks complete." }), cfg);
		expect(back.to).toBe("lead");
		expect(back.message!.text).toMatch(/the helper stopped/);
		expect(back.message!.text).toMatch(/Helper's last note: Task looks complete/);
		expect(decideTurn(s, turn({ calls: [c("l2", "read", { path: "b" })], specP: 0.99 }), cfg).to).toBe("lead");
		expect(decideTurn(s, turn({ calls: [c("l3", "read", { path: "c" })], specP: 0.99 }), cfg).to).toBe("spec");
	});
	it("low p → the lead continues; lead turn without calls → done", () => {
		const s = lead();
		expect(decideTurn(s, turn({ calls: [c("l1", "read", { path: "a" })], specP: 0.4 }), cfg).to).toBe("lead");
		expect(decideTurn(s, turn({ text: "DONE" }), cfg).to).toBe("done");
	});
	it("lead view hides the helper's speculative calls", () => {
		const s = lead();
		const msgs = [
			{ role: "assistant", model: "opus", content: [{ type: "toolCall", id: "l1", name: "bash", arguments: {} }] },
			{ role: "toolResult", toolCallId: "l1", content: [{ type: "text", text: "LEAD RESULT" }] },
			{ role: "assistant", model: "glm", content: [{ type: "toolCall", id: "h1", name: "edit", arguments: {} }] },
			{ role: "toolResult", toolCallId: "h1", content: [{ type: "text", text: "HELPER RESULT" }] },
		] as never[];
		const v = JSON.stringify(shapeContext(msgs, s, true, "opus"));
		expect(v).toContain("LEAD RESULT");
		expect(v).not.toContain("HELPER RESULT");
	});
	it("summary is clipped to summaryChars", () => {
		const run = { n: 8, steps: 8, p: 0.99, calls: Array.from({ length: 200 }, (_, i) => ({ name: "bash", arg: `cmd ${i} ${"x".repeat(100)}`, ok: true, out: "y".repeat(150) })), note: "" };
		const txt = specSummary(run, "step limit 8", "", 3000);
		expect(txt.length).toBeLessThanOrEqual(3000);
		expect(txt).toMatch(/Continue the task from here\.$/);
	});
});
