import { describe, expect, it } from "vitest";
import { type Call, DEFAULT_SWITCH, decideTurn, gateCall, initialSwitchState, LEAD_EDIT_TOOL_NOTE, shapeContext, type TurnInput } from "../src/pi/switch-core.ts";

const cfg = DEFAULT_SWITCH;
const c = (id: string, name: string, args: Record<string, unknown> = {}): Call => ({ id, name, args });
let t = 0;
const turn = (p: Partial<TurnInput>): TurnInput => ({ turn: t++, now: 1000 + t, text: "", calls: [], results: [], empty: false, ...p });
const REQ = "Add src/game/profiles.ts: reatomProfiles with create/select/rename/remove, persisted with withLocalStorage; tests in profiles.test.ts.";

const start = () => {
	const s = initialSwitchState(0);
	s.phase = "lead";
	const d = decideTurn(s, turn({ calls: [c("be1", "baton_edit", { request: REQ })], results: [{ id: "be1", isError: false, text: "baton_edit: the helper is making the edit…" }] }), cfg);
	return { s, d };
};

describe("0.12 baton_edit: the lead edits through a tool, the helper performs it in the same session", () => {
	it("on by default; the system note asks to always use it", () => {
		expect(cfg.editTool).toBe(true);
		expect(LEAD_EDIT_TOOL_NOTE).toMatch(/ALWAYS call baton_edit/);
		expect(LEAD_EDIT_TOOL_NOTE).toMatch(/write\/edit/);
	});
	it("baton_edit → implement with the free-text request as spec", () => {
		const { s, d } = start();
		expect(d.to).toBe("implement");
		expect(d.message?.audience).toBe("helper");
		expect(d.message?.text).toContain(REQ);
		expect(s.pendingEdit?.id).toBe("be1");
		expect(s.editTool?.calls).toBe(1);
	});
	it("helper only: baton_edit is lead-only", () => {
		const s = initialSwitchState(0);
		s.phase = "implement";
		expect(gateCall(s, c("x", "baton_edit", { request: "y" }), () => true)?.block).toBe(true);
	});
	it("green → the tool result (lead view) is replaced by DONE + summary; short lead message", () => {
		const { s } = start();
		decideTurn(s, turn({ calls: [c("w", "write", { path: "src/game/profiles.ts", content: "x" })] }), cfg);
		const back = decideTurn(s, { ...turn({ text: "IMPLEMENTED" }), autoCheck: () => ({ ok: true, text: "ok" }), diffStat: () => " src/game/profiles.ts | 1 +" }, cfg);
		expect(back.to).toBe("lead");
		expect(back.message?.text).toMatch(/baton_edit finished \(done/);
		expect(s.stubs.be1).toMatch(/^baton_edit: DONE/);
		expect(s.editTool).toMatchObject({ ok: 1, failed: 0 });
		const msgs = [
			{ role: "assistant", model: "lead", content: [{ type: "toolCall", id: "be1", name: "baton_edit", arguments: { request: REQ } }] },
			{ role: "toolResult", toolCallId: "be1", content: [{ type: "text", text: "baton_edit: the helper is making the edit…" }] },
			{ role: "assistant", model: "glm", content: [{ type: "toolCall", id: "w", name: "write", arguments: {} }] },
			{ role: "toolResult", toolCallId: "w", content: [{ type: "text", text: "ok" }] },
		] as never[];
		const lead = shapeContext(msgs, s, true, "lead") as { role: string; toolCallId?: string; content: { text?: string }[] }[];
		expect(lead.map((m) => m.toolCallId ?? m.role)).toEqual(["assistant", "be1"]); // helper calls hidden
		expect(lead[1]!.content[0]!.text).toMatch(/^baton_edit: DONE/);
	});
	it("helper escalates → NOT DONE result telling the lead to edit itself", () => {
		const { s } = start();
		s.lastVerifyGreen = false;
		const back = decideTurn(s, turn({ text: "ESCALATE needs a design decision" }), cfg);
		expect(back.to).toBe("lead");
		expect(s.stubs.be1).toMatch(/^baton_edit: NOT DONE/);
		expect(s.stubs.be1).toMatch(/yourself with write\/edit/);
		expect(s.editTool).toMatchObject({ ok: 0, failed: 1 });
	});
	it("editTool off → baton_edit is not intercepted (edit-intent remains the alternative)", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		const d = decideTurn(s, turn({ calls: [c("be", "baton_edit", { request: REQ })] }), { ...cfg, editTool: false });
		expect(d.to).not.toBe("implement");
	});
});
