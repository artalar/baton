import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/pi/config.ts";
import type { JournalEvent } from "../src/core/journal.ts";
import { cutLoops, type DeferredItem } from "../src/pi/loop.ts";
import { applyHandoff, handoffSnapshot, type MsgLike } from "../src/pi/mask.ts";
import { pickFirstKeptForCalls } from "../src/pi/reset.ts";

const big = (t: string) => `${t}:${"x".repeat(2000)}`;
const call = (id: string, name: string, args: object): MsgLike => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const res = (id: string, name: string, text = big(id)): MsgLike => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }] });
const ev = (evt: number, tool: string): JournalEvent => ({ evt, ts: "", turn: 0, kind: "tool_call", tool, argsDigest: "a", exit: 0, outTokens: 500 });
const opts = { enabled: true, exemptTools: DEFAULT_CONFIG.compact.exemptTools, neverMaskPaths: DEFAULT_CONFIG.compact.neverMaskPaths, dedupReads: false, staleReads: false, cwd: "/r" };
const lookup = (id: string) => ev(Number(id.slice(1)), "read");
const text = (m: MsgLike) => (m.content as { text: string }[])[0]!.text;

/** Simulates the context event in handoff mode for a growing conversation. */
function request(msgs: MsgLike[], snap: ReturnType<typeof handoffSnapshot> | undefined) {
	const m = applyHandoff(msgs, snap, lookup, opts).messages;
	return snap?.cut.length ? cutLoops(m, snap.cut).messages : m;
}

describe("handoff compaction (compact.enabled)", () => {
	it("is optional and off by default; the loop detector forces baton_help", () => {
		expect(DEFAULT_CONFIG.compact.enabled).toBe(false);
		expect(DEFAULT_CONFIG.loop.action).toBe("help");
	});

	it("leaves the context untouched between handoffs, compacts it after one, then freezes it", () => {
		const msgs: MsgLike[] = [{ role: "user", content: "task" }];
		// work before any handoff: repeated reads of the same file, a write after a read — nothing is rewritten
		for (const [i, id] of ["c1", "c2", "c3", "c4"].entries()) {
			msgs.push(call(id, i === 2 ? "edit" : "read", { path: "src/pieces.ts" }), res(id, i === 2 ? "edit" : "read"));
			expect(request(msgs, undefined)).toEqual(msgs);
		}
		// handoff (baton_review answered): keep last 2 calls verbatim, older ones → evt# stubs
		const snap = handoffSnapshot(1, ["c1", "c2", "c3", "c4"], 2, []);
		msgs.push(call("r1", "baton_review", {}), res("r1", "baton_review", "PLAN …"));
		const after = request(msgs, snap);
		expect(text(after[2]!)).toContain("evt#1");
		expect(text(after[2]!)).toContain("baton_recall");
		expect(text(after[4]!)).toContain("evt#2");
		expect(text(after[6]!)).toBe(big("c3"));
		expect(text(after[8]!)).toBe(big("c4"));
		expect(text(after[10]!)).toBe("PLAN …");
		// more work after the handoff: the prefix stays byte-identical, new messages are verbatim
		const prefix = JSON.stringify(after);
		for (const id of ["c5", "c6", "c7"]) {
			msgs.push(call(id, "read", { path: "src/pieces.ts" }), res(id, "read"));
			const now = request(msgs, snap);
			expect(JSON.stringify(now.slice(0, after.length))).toBe(prefix);
			expect(now.slice(after.length)).toEqual(msgs.slice(after.length));
		}
		// the next handoff compacts the calls made since the previous one
		const snap2 = handoffSnapshot(2, ["c1", "c2", "c3", "c4", "c5", "c6", "c7"], 0, []);
		const after2 = request(msgs, snap2);
		expect(text(after2.at(-1)!)).toContain("evt#7");
		expect(text(after2[10]!)).toBe("PLAN …"); // advisor replies are never stubbed
	});

	it("never stubs skills and reference docs", () => {
		const msgs = [call("c1", "read", { path: ".agents/skills/x/SKILL.md" }), res("c1", "read")];
		expect(applyHandoff(msgs, handoffSnapshot(1, ["c1"], 0, []), lookup, opts).messages).toEqual(msgs);
	});

	it("cuts a deferred loop only at the handoff the loop forced", () => {
		const msgs: MsgLike[] = [{ role: "user", content: "task" }];
		for (const id of ["c1", "c2", "c3"]) msgs.push(call(id, "bash", { command: "npm test" }), res(id, "bash"));
		const d: DeferredItem = { id: "D1", key: "fail:x", target: 'test "x"', count: 3, files: [], cut: ["c1", "c2", "c3"], status: "deferred" };
		expect(request(msgs, undefined)).toEqual(msgs); // detection alone does not cut
		const out = request(msgs, handoffSnapshot(1, ["c1", "c2", "c3"], 0, [d]));
		expect(out.filter((m) => m.role === "toolResult")).toHaveLength(1);
		expect(text(out.find((m) => m.role === "toolResult")!)).toContain("Loop detected (D1)");
	});

	it("keeps the session entry of the earliest kept call on reset", () => {
		const entries = [
			{ id: "e1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1" }] } },
			{ id: "e2", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c2" }] } },
			{ id: "e3", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c3" }] } },
		];
		expect(pickFirstKeptForCalls(entries, ["c2", "c3"], "e3")).toBe("e2");
		expect(pickFirstKeptForCalls(entries, ["c3"], "e2")).toBe("e2");
		expect(pickFirstKeptForCalls(entries, [], "e3")).toBe("e3");
	});
});
