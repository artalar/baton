import { describe, expect, it } from "vitest";
import type { JournalEvent } from "../src/journal.ts";
import { maskMessages, type MsgLike } from "../src/mask.ts";

const big = "x".repeat(2000);
const call = (id: string, name: string, args: object): MsgLike => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const res = (id: string, name: string, text = big): MsgLike => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }] });
const ev = (evt: number, tool: string): JournalEvent => ({ evt, ts: "", turn: 0, kind: "tool_call", tool, argsDigest: "a", exit: 0, outTokens: 500 });
const opts = { enabled: true, exemptTools: ["baton_review"], dedupReads: true, staleReads: true, cwd: "/r" };
const lookup = (m: Record<string, JournalEvent>) => (id: string) => m[id];
const text = (m: MsgLike) => (m.content as { text: string }[])[0]!.text;

describe("maskMessages", () => {
	it("masks answered outputs with evt stubs and keeps the fresh batch", () => {
		const msgs = [{ role: "user", content: "task" }, call("a", "bash", { command: "ls" }), res("a", "bash"), call("b", "bash", { command: "pwd" }), res("b", "bash")];
		const { messages, stats } = maskMessages(msgs, lookup({ a: ev(1, "bash"), b: ev(2, "bash") }), opts);
		expect(text(messages[2]!)).toContain("evt#1");
		expect(text(messages[2]!)).toContain("baton_recall");
		expect(text(messages[4]!)).toBe(big);
		expect(stats.masked).toBe(1);
		expect(msgs[2]!.content).not.toBe(messages[2]!.content); // input untouched
		expect(text(msgs[2]!)).toBe(big);
	});
	it("does not mask exempt tools", () => {
		const msgs = [call("a", "baton_review", {}), res("a", "baton_review"), call("b", "bash", {})];
		expect(text(maskMessages(msgs, lookup({}), opts).messages[1]!)).toBe(big);
	});
	it("replaces duplicate reads of the same file, even in the fresh batch", () => {
		const msgs = [call("a", "read", { path: "f.ts" }), res("a", "read"), call("b", "read", { path: "/r/f.ts" }), res("b", "read")];
		const { messages, stats } = maskMessages(msgs, lookup({ a: ev(1, "read"), b: ev(2, "read") }), opts);
		expect(text(messages[1]!)).toContain("duplicate read, superseded by evt#2");
		expect(stats.deduped).toBe(1);
	});
	it("marks reads stale after a write to the same file", () => {
		const msgs = [call("a", "read", { path: "f.ts" }), res("a", "read"), call("w", "edit", { path: "f.ts" }), res("w", "edit", "ok")];
		const { messages, stats } = maskMessages(msgs, lookup({ a: ev(1, "read"), w: ev(2, "edit") }), opts);
		expect(text(messages[1]!)).toContain("stale read, file changed at evt#2");
		expect(stats.stale).toBe(1);
	});
	it("is a no-op when disabled and stable across calls", () => {
		const msgs = [call("a", "bash", {}), res("a", "bash"), call("b", "bash", {})];
		expect(maskMessages(msgs, lookup({}), { ...opts, enabled: false }).messages).toEqual(msgs);
		const l = lookup({ a: ev(1, "bash") });
		expect(maskMessages(msgs, l, opts).messages).toEqual(maskMessages(msgs, l, opts).messages);
	});
});
