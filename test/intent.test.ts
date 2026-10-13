import { describe, expect, it } from "vitest";
import { type Call, DEFAULT_SWITCH, decideTurn, initialSwitchState, intentFiles, LEAD_INTENT_NOTE, parseEditIntent, type TurnInput } from "../src/pi/switch-core.ts";

const cfg = DEFAULT_SWITCH;
const c = (id: string, name: string, args: Record<string, unknown> = {}): Call => ({ id, name, args });
let t = 0;
const turn = (p: Partial<TurnInput>): TurnInput => ({ turn: t++, now: 1000 + t, text: "", calls: [], results: [], empty: false, ...p });
const INTENT = "Plan done.\n<edit-intent>\nfiles: src/game/profiles.ts, src/game/profiles.test.ts\nchange: add reatomProfiles with create/select/rename/remove actions persisted via withLocalStorage; tests for each action\nwhy: feature (a)\n</edit-intent>";

describe("0.11.1 edit intents: the lead states the edit, the helper performs it", () => {
	it("system note asks for the intent block", () => {
		expect(LEAD_INTENT_NOTE).toMatch(/<edit-intent>/);
		expect(LEAD_INTENT_NOTE).toMatch(/interruption summary/);
	});
	it("parses the block and its files", () => {
		const i = parseEditIntent(INTENT)!;
		expect(i).toMatch(/^files:/);
		expect(intentFiles(i)).toEqual(["src/game/profiles.ts", "src/game/profiles.test.ts"]);
		expect(parseEditIntent("no intent here")).toBeUndefined();
		expect(parseEditIntent("<edit-intent></edit-intent>")).toBeUndefined();
	});
	it("intent without edits → implement with the intent as spec; green → lead, no failure", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		const d = decideTurn(s, turn({ text: INTENT }), cfg);
		expect(d.to).toBe("implement");
		expect(d.message?.audience).toBe("helper");
		expect(d.message?.text).toMatch(/reatomProfiles/);
		expect(d.message?.text).toMatch(/only the files listed/);
		expect(d.continue).toBe(true);
		decideTurn(s, turn({ calls: [c("w", "write", { path: "src/game/profiles.ts", content: "x" })] }), cfg);
		const back = decideTurn(s, { ...turn({ text: "IMPLEMENTED" }), autoCheck: () => ({ ok: true, text: "ok" }) }, cfg);
		expect(back.to).toBe("lead");
		expect(back.message?.text).not.toMatch(/did NOT finish/);
		expect(s.intents).toMatchObject({ handed: 1, failed: 0, selfNext: false });
	});
	it("helper escalates → lead is told to make the edit itself, and its next intent is not handed over", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		decideTurn(s, turn({ text: INTENT }), cfg);
		s.lastVerifyGreen = false;
		const back = decideTurn(s, turn({ text: "ESCALATE unclear API" }), cfg);
		expect(back.to).toBe("lead");
		expect(back.message?.text).toMatch(/did NOT finish your edit intent: make that edit yourself/);
		expect(s.intents).toMatchObject({ failed: 1, selfNext: true });
		const self = decideTurn(s, turn({ text: INTENT }), cfg);
		expect(self.to).toBe("lead");
		expect(self.message?.text).toMatch(/Make the edit yourself/);
		// after the lead edits itself, intents are handed over again
		decideTurn(s, turn({ calls: [c("e", "edit", { path: "src/game/profiles.ts" })] }), cfg);
		expect(s.intents!.selfNext).toBe(false);
		expect(decideTurn(s, turn({ text: INTENT }), cfg).to).toBe("implement");
	});
	it("an intent together with the lead's own edits in the same turn is not handed over", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		expect(decideTurn(s, turn({ text: INTENT, calls: [c("w", "write", { path: "src/a.ts", content: "x" })] }), cfg).to).not.toBe("implement");
	});
	it("after maxIntentFailures the lead edits itself", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		s.intents = { handed: 2, failed: 2, fromIntent: false, selfNext: false };
		expect(decideTurn(s, turn({ text: INTENT }), cfg).to).toBe("lead");
	});
});
