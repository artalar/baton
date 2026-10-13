import { describe, expect, it } from "vitest";
import { type Call, DEFAULT_SWITCH, decideTurn, gateCall, initialSwitchState, LEAD_EDIT_TOOL_NOTE, type TurnInput } from "../src/pi/switch-core.ts";

const cfg = DEFAULT_SWITCH;
const c = (id: string, name: string, args: Record<string, unknown> = {}): Call => ({ id, name, args });
let t = 0;
const turn = (p: Partial<TurnInput>): TurnInput => ({ turn: t++, now: 1000 + t, text: "", calls: [], results: [], empty: false, ...p });
const SKILL = `# reatom persist\n${"withLocalStorage(key) keeps the atom in localStorage. ".repeat(400)}END-OF-SKILL`;

const start = () => {
	const s = initialSwitchState(0);
	s.phase = "lead";
	const d = decideTurn(s, turn({ calls: [c("br1", "baton_read", { request: "How does withLocalStorage work? Read the reatom persist skill and src/game/model.ts" })] }), cfg);
	return { s, d };
};

describe("0.12.1 baton_read: the helper reads, the lead gets the outputs verbatim in one tool result", () => {
	it("on by default; system note prefers baton_read for studying, baton_edit for edits", () => {
		expect(cfg.readTool).toBe(true);
		expect(LEAD_EDIT_TOOL_NOTE).toMatch(/baton_read\(\{request\}\) — to study code/);
		expect(LEAD_EDIT_TOOL_NOTE).toMatch(/baton_edit\(\{request\}\) — to change files/);
	});
	it("baton_read → followup with the request; edits are blocked while the helper reads", () => {
		const { s, d } = start();
		expect(d.to).toBe("followup");
		expect(d.message?.text).toMatch(/withLocalStorage/);
		expect(s.pendingRead?.id).toBe("br1");
		expect(gateCall(s, c("w", "write", { path: "x.ts" }), () => false)?.block).toBe(true);
	});
	it("hand-back: tool result = verbatim outputs, deduplicated, skill in full, no helper reasoning", () => {
		const { s } = start();
		const reads = [c("r1", "read", { path: ".agents/skills/reatom-persist/SKILL.md" }), c("r2", "read", { path: "src/game/model.ts" }), c("r3", "read", { path: "src/game/model.ts" })];
		decideTurn(
			s,
			turn({
				text: "Let me think: I believe the persist API is tricky (GLM REASONING)",
				calls: reads,
				results: [
					{ id: "r1", isError: false, text: SKILL },
					{ id: "r2", isError: false, text: "export const game = atom(0)" },
					{ id: "r3", isError: false, text: "export const game = atom(0)" },
				],
			}),
			cfg,
		);
		decideTurn(s, turn({ calls: Array.from({ length: 3 }, (_, i) => c(`g${i}`, "grep", { pattern: `p${i}` })), results: Array.from({ length: 3 }, (_, i) => ({ id: `g${i}`, isError: false, text: `hit ${i}` })) }), cfg);
		const back = decideTurn(s, turn({ text: "READ DONE" }), cfg);
		expect(back.to).toBe("lead");
		expect(back.message?.text).toMatch(/baton_read finished/);
		const res = s.stubs.br1!;
		expect(res).toContain("END-OF-SKILL"); // skill not clipped
		expect(res.split("export const game = atom(0)").length - 1).toBe(1); // deduplicated
		expect(res).not.toContain("GLM REASONING");
		expect(s.readTool?.calls).toBe(1);
	});
	it("limit reached → the tool result tells the lead to read itself", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		s.readTool = { calls: cfg.maxReadTool, chars: 0 };
		const d = decideTurn(s, turn({ calls: [c("br9", "baton_read", { request: "x" })] }), cfg);
		expect(d.to).not.toBe("followup");
		expect(s.stubs.br9).toMatch(/read it yourself/);
	});
	it("readTool off → baton_read not intercepted", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		expect(decideTurn(s, turn({ calls: [c("b", "baton_read", { request: "x" })] }), { ...cfg, readTool: false }).to).not.toBe("followup");
	});
});
