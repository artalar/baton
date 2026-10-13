import { describe, expect, it } from "vitest";
import { type Call, DEFAULT_SWITCH, decideTurn, gateCall, initialSwitchState, shapeContext, specEstimate, specStartN, specSteps, specSummary, type TurnInput } from "../src/pi/switch-core.ts";
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

describe("0.13.1 length control", () => {
	const all = { ...DEFAULT_SWITCH, spec: { ...DEFAULT_SWITCH.spec, enabled: true, freeStops: true, estimate: true, phase: true, gate: { ...DEFAULT_SWITCH.spec.gate, on: true }, adapt: { ...DEFAULT_SWITCH.spec.adapt, on: true } } };
	const ok = (id: string) => ({ id, isError: false, text: "ok" });
	it("start N = min(maxSteps, estimate, cap); estimate from P(≥3/6/10)", () => {
		expect(specEstimate(0.9, 0.7, 0.3)).toBe(6);
		expect(specEstimate(0.2, 0.1, 0.1)).toBe(2);
		expect(specStartN(0.99, 10, 6, all.spec)).toBe(6);
		expect(specStartN(0.99, 3, 6, all.spec)).toBe(3);
		expect(specStartN(0.5, 10, 10, all.spec)).toBe(0);
		expect(specStartN(0.99, 10, 10, all.spec)).toBe(10);
	});
	it("v1: Jev P(continue) < thr after the free steps stops the run; not before", () => {
		const s = lead();
		decideTurn(s, turn({ calls: [c("l1", "read", { path: "a" })], results: [ok("l1")], specP: 0.99, specEst: 10 }), all);
		expect(decideTurn(s, turn({ calls: [c("h1", "read", { path: "b" })], results: [ok("h1")], specCont: 0.1 }), all).to).toBe("spec");
		decideTurn(s, turn({ calls: [c("h2", "read", { path: "c" })], results: [ok("h2")] }), all);
		const d = decideTurn(s, turn({ calls: [c("h3", "read", { path: "d" })], results: [ok("h3")], specCont: 0.4 }), all);
		expect(d.to).toBe("lead");
		expect(d.message!.text).toMatch(/P\(continue\) 0\.40/);
	});
	it("v2: tool error, repeated call, text-only answer → lead", () => {
		let s = lead();
		decideTurn(s, turn({ calls: [c("l1", "read", { path: "a" })], results: [ok("l1")], specP: 0.99, specEst: 10 }), all);
		expect(decideTurn(s, turn({ calls: [c("h1", "bash", { command: "ls x" })], results: [{ id: "h1", isError: true, text: "no such file" }] }), all).message!.text).toMatch(/tool error/);
		s = lead();
		decideTurn(s, turn({ calls: [c("l1", "read", { path: "a" })], results: [ok("l1")], specP: 0.99, specEst: 10 }), all);
		expect(gateCall(s, c("h1", "read", { path: "a" }), () => true)?.block).toBe(true);
		expect(decideTurn(s, turn({ calls: [c("h1", "read", { path: "a" })], results: [] , text: "x"}), { ...all }).message!.text).toMatch(/repeated call/);
	});
	it("v4: after reads the first edit is blocked and hands back; after a lead edit only the same files may be edited", () => {
		let s = lead();
		decideTurn(s, turn({ calls: [c("l1", "read", { path: "a" })], results: [ok("l1")], specP: 0.99, specEst: 10 }), all);
		expect(gateCall(s, c("h1", "bash", { command: "npx vitest run" }), () => true)).toBeUndefined();
		expect(gateCall(s, c("h2", "edit", { path: "src/a.ts" }), () => true)?.block).toBe(true);
		expect(decideTurn(s, turn({ calls: [c("h1", "bash", { command: "npx vitest run" }), c("h2", "edit", { path: "src/a.ts" })], results: [ok("h1")] }), all).message!.text).toMatch(/phase change/);
		s = lead();
		decideTurn(s, turn({ calls: [c("l1", "edit", { path: "src/a.ts" })], results: [ok("l1")], specP: 0.99, specEst: 10 }), all);
		expect(gateCall(s, c("h1", "edit", { path: "src/a.ts", oldText: "1" }), () => true)).toBeUndefined();
		expect(gateCall(s, c("h2", "write", { path: "src/b.ts" }), () => true)?.block).toBe(true);
	});
	it("v5: lead reworks the helper's files → cap −2; continues → +1; bounded 2..10", () => {
		const s = lead();
		decideTurn(s, turn({ calls: [c("l1", "edit", { path: "a.ts" })], results: [ok("l1")], specP: 0.99, specEst: 10 }), all);
		decideTurn(s, turn({ calls: [c("h1", "edit", { path: "a.ts", x: 1 })], results: [ok("h1")] }), all);
		decideTurn(s, turn({ text: "done" }), all);
		decideTurn(s, turn({ calls: [c("l2", "edit", { path: "a.ts", y: 2 })], results: [ok("l2")] }), all);
		expect(s.specCap).toBe(4);
		expect(s.specAdaptLog![0]!.verdict).toBe("rework");
		s.specJudge = { files: ["a.ts"], sigs: [] };
		decideTurn(s, turn({ calls: [c("l3", "read", { path: "z" })], results: [ok("l3")], specP: 0.99, specEst: 10 }), all);
		expect(s.specCap).toBe(5);
		expect(s.specRun!.n).toBe(5);
	});
});
