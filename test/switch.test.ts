import { describe, expect, it } from "vitest";
import { anchorCache, capMaxTokens, capReasoning, DEFAULT_SWITCH, decideTurn, failSignature, gateCall, initialSwitchState, isReadOnly, isVerify, shapeContext, type Call, type TurnInput } from "../src/pi/switch-core.ts";

const cfg = { ...DEFAULT_SWITCH };
const c = (id: string, name: string, args: Record<string, unknown> = {}): Call => ({ id, name, args });
let t = 0;
const turn = (p: Partial<TurnInput>): TurnInput => ({ turn: t++, now: 1000 + t, text: "", calls: [], results: [], empty: false, ...p });

describe("classifiers", () => {
	it("read-only calls", () => {
		expect(isReadOnly(c("1", "read", { path: "a" }))).toBe(true);
		expect(isReadOnly(c("1", "bash", { command: "ls -la && cat package.json | head -20" }))).toBe(true);
		expect(isReadOnly(c("1", "bash", { command: "cd .agents && rg atom" }))).toBe(true);
		expect(isReadOnly(c("1", "bash", { command: 'cat a b; echo "---"; ls node_modules 2>/dev/null | head; npm ls --prefix /x 2>/dev/null | head; git -C /x log --oneline | head -5' }))).toBe(true);
		expect(isReadOnly(c("1", "bash", { command: "cat a > b" }))).toBe(false);
		expect(isReadOnly(c("1", "bash", { command: "npm install" }))).toBe(false);
		expect(isReadOnly(c("1", "edit", {}))).toBe(false);
	});
	it("verify runs", () => {
		expect(isVerify(c("1", "bash", { command: "npx vitest run 2>&1 | tail" }))).toBe(true);
		expect(isVerify(c("1", "bash", { command: "npm run build" }))).toBe(true);
		expect(isVerify(c("1", "bash", { command: "npm install" }))).toBe(false);
	});
	it("fail signature ignores durations and line numbers", () => {
		expect(failSignature("FAIL src/a.test.ts > x\nError: boom at a.ts:12:3 (12ms)")).toBe(failSignature("FAIL src/a.test.ts > x\nError: boom at a.ts:40:9 (99ms)"));
	});
});

describe("state machine", () => {
	it("reading → lead when the helper stops reading or tries to edit; planning gets full thinking once", () => {
		const s = initialSwitchState(0);
		expect(decideTurn(s, turn({ calls: [c("r1", "read", { path: "a.md" })] }), cfg).to).toBe("read");
		expect(gateCall(s, c("e1", "edit", { path: "x" }), () => true)).toBeUndefined(); // 0.8.1: any tool; the fs guard reverts
		s.wantLead = "helper changed the working tree during reading (fs guard)";
		s.dropped.push("e1");
		const d = decideTurn(s, turn({ calls: [c("e1", "edit")] }), cfg);
		expect(d.to).toBe("lead");
		expect(d.message?.audience).toBe("lead");
		expect(s.planningLeft).toBe(1);
		expect(s.switches).toHaveLength(1);
	});
	it("text-only helper turn hands over and asks pi to continue; long reasoning text also ends reading", () => {
		const s = initialSwitchState(0);
		expect(decideTurn(s, turn({ text: "READ DONE" }), cfg)).toMatchObject({ to: "lead", continue: true });
		const s2 = initialSwitchState(0);
		expect(decideTurn(s2, turn({ text: "x".repeat(400), calls: [c("r", "read", { path: "a" })] }), cfg).to).toBe("lead");
	});
	it("helper stretch over the cache TTL hands back", () => {
		const s = initialSwitchState(0);
		expect(decideTurn(s, { turn: 1, now: 300_000, text: "", calls: [c("r", "ls")], results: [], empty: false }, cfg).to).toBe("lead");
	});
	it("lead: delegate_reads → follow-up (max 2), only-reads heuristic, verify after edits → debug", () => {
		const s = initialSwitchState(0);
		decideTurn(s, turn({ text: "READ DONE" }), cfg);
		const d = decideTurn(s, turn({ calls: [c("d", "delegate_reads", { instruction: "read src/x.ts" })] }), cfg);
		expect(d.to).toBe("followup");
		expect(d.message?.text).toContain("src/x.ts");
		decideTurn(s, turn({ text: "READ DONE" }), cfg);
		expect(decideTurn(s, turn({ calls: [c("a", "read", { path: "a" }), c("b", "read", { path: "b" })] }), cfg).to).toBe("lead"); // one read turn
		expect(decideTurn(s, turn({ calls: [c("b2", "bash", { command: "rg atom src" })] }), cfg).to).toBe("followup"); // 2nd consecutive
		decideTurn(s, turn({ text: "READ DONE" }), cfg);
		expect(decideTurn(s, turn({ calls: [c("d2", "delegate_reads", { instruction: "more" })] }), cfg).to).toBe("lead"); // rounds exhausted
		decideTurn(s, turn({ calls: [c("w", "write", { path: "a.ts" })] }), cfg);
		expect(decideTurn(s, turn({ calls: [c("v", "bash", { command: "npx vitest run" })], results: [{ id: "v", isError: true, text: "FAIL x" }] }), cfg).to).toBe("debug");
	});
	it("debug escalates after N=6 red cycles with the same failure, compacting old verify outputs", () => {
		const s = initialSwitchState(0);
		s.phase = "debug";
		let d;
		for (let i = 0; i < 6; i++) {
			d = decideTurn(s, turn({ calls: [c(`e${i}`, "edit", { path: "a.ts" })] }), cfg);
			d = decideTurn(s, turn({ calls: [c(`v${i}`, "bash", { command: "npm test" })], results: [{ id: `v${i}`, isError: true, text: `FAIL a\nError: same (${i}ms)` }] }), cfg);
		}
		expect(d!.to).toBe("lead");
		expect(d!.reason).toContain("red cycles");
		expect(Object.keys(s.stubs)).toEqual(["v0", "v1", "v2", "v3"]);
		expect(s.planningLeft).toBe(1);
	});
	it("debug: different failures do not escalate before the total cap; green → back to lead; review → final → done", () => {
		const s = initialSwitchState(0);
		s.phase = "debug";
		for (let i = 0; i < 5; i++) {
			decideTurn(s, turn({ calls: [c(`e${i}`, "edit")] }), cfg);
			expect(decideTurn(s, turn({ calls: [c(`v${i}`, "bash", { command: "npm test" })], results: [{ id: `v${i}`, isError: true, text: `Error: e${"x".repeat(i)}` }] }), cfg).to).toBe("debug");
		}
		decideTurn(s, turn({ calls: [c("vg", "bash", { command: "npm test" })], results: [{ id: "vg", isError: false, text: "ok" }] }), cfg);
		expect(decideTurn(s, turn({ text: "GREEN" }), cfg).to).toBe("lead");
		expect(decideTurn(s, turn({ text: "All done." }), cfg).to).toBe("review");
		expect(decideTurn(s, turn({ text: "NONE" }), cfg)).toMatchObject({ to: "final", continue: true });
		expect(decideTurn(s, turn({ text: "DONE" }), cfg)).toMatchObject({ to: "done", continue: false });
	});
	it("lead finishing after edits without a verify → debug; green → review directly", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		decideTurn(s, turn({ calls: [c("w", "write", { path: "a.ts" })] }), cfg);
		expect(decideTurn(s, turn({ text: "done", testsExist: true }), cfg)).toMatchObject({ to: "debug", continue: true });
		decideTurn(s, turn({ calls: [c("v", "bash", { command: "npm test" })], results: [{ id: "v", isError: false, text: "ok" }] }), cfg);
		expect(decideTurn(s, turn({ text: "GREEN" }), cfg).to).toBe("review");
	});
	it("helper creating a new file in debug is blocked and escalates", () => {
		const s = initialSwitchState(0);
		s.phase = "debug";
		expect(gateCall(s, c("w", "write", { path: "new.ts" }), () => false)?.block).toBe(true);
		expect(gateCall(s, c("w2", "write", { path: "old.ts" }), () => true)).toBeUndefined();
		s.blocked.push("w");
		expect(decideTurn(s, turn({ calls: [c("w", "write")] }), cfg).to).toBe("lead");
	});
	it("empty lead responses are retried, then given up", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		for (let i = 0; i < 3; i++) expect(decideTurn(s, turn({ empty: true }), cfg)).toMatchObject({ to: "lead", continue: true });
		expect(decideTurn(s, turn({ empty: true }), cfg).continue).toBeFalsy();
	});
	it("duplicate reads are stubbed at the read→lead handoff, the latest is clipped not stubbed", () => {
		const s = initialSwitchState(0);
		decideTurn(s, turn({ calls: [c("r1", "read", { path: "a.ts" }), c("r2", "bash", { command: "cat ./a.ts" })] }), cfg);
		decideTurn(s, turn({ text: "READ DONE" }), cfg);
		expect(Object.keys(s.stubs)).toEqual(["r1"]);
		expect(s.clips.r2).toBe(cfg.clipChars);
	});
});

describe("cache safety", () => {
	it("compaction never touches content the lead has already seen", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		decideTurn(s, turn({ calls: [c("o1", "read", { path: "a.ts" })] }), cfg); // lead read: cached
		s.phase = "debug";
		decideTurn(s, turn({ calls: [c("h1", "read", { path: "a.ts" }), c("h2", "read", { path: "a.ts" })] }), cfg);
		decideTurn(s, turn({ text: "GREEN" }), cfg);
		expect(Object.keys(s.stubs)).toEqual(["h1"]);
		expect(s.clips.o1).toBeUndefined();
		expect(s.clips.h2).toBe(cfg.clipChars);
	});
});

describe("shapeContext", () => {
	const lead = "anthropic/claude-opus-5.5";
	const msgs = [
		{ role: "user", content: "task" },
		{ role: "custom", customType: "baton-switch-helper", content: "read!" },
		{ role: "assistant", model: "z-ai/glm-5.3-flash", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "I will read" }, { type: "toolCall", id: "g1", name: "read" }, { type: "toolCall", id: "g2", name: "edit" }] },
		{ role: "toolResult", toolCallId: "g1", content: [{ type: "text", text: "x".repeat(50) }] },
		{ role: "toolResult", toolCallId: "g2", content: [{ type: "text", text: "blocked" }] },
		{ role: "assistant", model: "z-ai/glm-5.3-flash", content: [{ type: "text", text: "READ DONE" }] },
		{ role: "assistant", model: lead, content: [{ type: "thinking", thinking: "plan", thinkingSignature: "sig" }, { type: "text", text: "ok" }] },
		{ role: "assistant", model: lead, content: [{ type: "text", text: "" }] },
	];
	it("for the lead: helper turns and their results vanish entirely (honest handoff); helper notes and empty replies vanish; Opus kept whole", () => {
		const out = shapeContext(msgs, { stubs: {}, clips: { g1: 20 }, blocked: ["g2"] }, true, lead);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(out[1]).toBe(msgs[6]);
	});
	it("for the helper: history untouched except compaction and empty replies", () => {
		const out = shapeContext(msgs, { stubs: { g1: "STUB" }, clips: {}, blocked: ["g2"] }, false, lead);
		expect(out).toHaveLength(7);
		expect((out[3]!.content as { text: string }[])[0]!.text).toBe("STUB");
	});
	it("anchors a cache breakpoint at the end of the lead's previous prefix", () => {
		const msgs = [{ role: "system", content: "s" }, { role: "user", content: "task" }, { role: "assistant", content: null }, { role: "tool", content: "out" }, { role: "assistant", content: null }, { role: "tool", content: "x" }, { role: "tool", content: "y" }];
		const r = anchorCache({ messages: msgs }, 4);
		const out = r.payload as { messages: { content: unknown }[] };
		expect(out.messages[3]!.content).toEqual([{ type: "text", text: "out", cache_control: { type: "ephemeral" } }]);
		expect(msgs[3]!.content).toBe("out");
		expect(r).toMatchObject({ anchored: true, at: 3, before: 0, after: 1 });
		expect(anchorCache({ messages: msgs }, 7).payload).toEqual({ messages: msgs });
	});
	it("caps lead max tokens", () => {
		expect(capMaxTokens({ max_tokens: 128000 }, 16000)).toEqual({ max_tokens: 16000 });
		expect(capMaxTokens({ max_completion_tokens: 100 }, 16000)).toEqual({ max_completion_tokens: 100 });
	});
	it("caps lead reasoning", () => {
		expect(capReasoning({ model: "m", reasoning: { effort: "high" } }, 1024)).toEqual({ model: "m", reasoning: { max_tokens: 1024 } });
	});
});
