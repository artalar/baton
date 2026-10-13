import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { argsDigest, buildToolEvent, errorSignature, Journal, parseTestSummary } from "../src/core/journal.ts";

const obs = (o: Partial<Parameters<typeof buildToolEvent>[1]> = {}) => ({
	tool: "bash", input: { command: "ls" }, output: "a\nb", isError: false, turn: 1, cwd: "/repo", now: new Date("2026-10-13T00:00:00Z"), ...o,
});

describe("journal", () => {
	it("builds a deterministic record", () => {
		const a = buildToolEvent(1, obs(), new Set());
		const b = buildToolEvent(1, obs(), new Set());
		expect(a).toEqual(b);
		expect(a).toMatchObject({ evt: 1, tool: "bash", exit: 0, errSig: null, rawRef: "raw/1.txt", ts: "2026-10-13T00:00:00.000Z" });
	});
	it("hashes write bodies and tracks files", () => {
		const e = buildToolEvent(2, obs({ tool: "write", input: { path: "src/a.ts", content: "secret body" } }), new Set());
		expect(e.argsDigest).not.toContain("secret body");
		expect(e.filesWritten).toEqual(["src/a.ts"]);
		expect(e.fileHashAfter?.["src/a.ts"]).toHaveLength(40);
		expect(e.importance).toBe(3);
	});
	it("normalises error signatures across numbers", () => {
		const a = errorSignature("TypeError: x is undefined at src/a.ts:12:5", true);
		const b = errorSignature("TypeError: x is undefined at src/a.ts:40:9", true);
		expect(a).toBe(b);
		expect(errorSignature("all good", false)).toBeNull();
	});
	it("marks repeated errors as importance 2", () => {
		const e1 = buildToolEvent(1, obs({ output: "Error: boom", isError: true, exitCode: 1 }), new Set());
		const e2 = buildToolEvent(2, obs({ output: "Error: boom", isError: true, exitCode: 1 }), new Set([e1.errSig!]));
		expect(e1.importance).toBe(3);
		expect(e2.importance).toBe(2);
		expect(e2.exit).toBe(1);
	});
	it("keeps head and tail of long outputs", () => {
		const out = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
		const e = buildToolEvent(1, obs({ output: out }), new Set());
		expect(e.outHead?.split("\n")).toHaveLength(10);
		expect(e.outTail?.split("\n").at(-1)).toBe("line99");
	});
	it("parses vitest and pytest summaries", () => {
		expect(parseTestSummary("npx vitest run", " FAIL  test/a.test.ts > adds\n Tests  2 failed | 5 passed (7)")).toMatchObject({ passed: 5, failed: 2, failedNames: ["test/a.test.ts > adds"] });
		expect(parseTestSummary("pytest -q", "=== 3 failed, 10 passed in 1.2s ===")).toMatchObject({ passed: 10, failed: 3 });
		expect(parseTestSummary("ls", "1 passed")).toBeNull();
	});
	it("argsDigest is capped at 200 chars", () => {
		expect(argsDigest("bash", { command: "x".repeat(500) }).length).toBeLessThanOrEqual(200);
	});
	it("persists to events.jsonl and raw files, and reloads", () => {
		const dir = mkdtempSync(join(tmpdir(), "baton-"));
		const j = new Journal(dir);
		j.record("user_prompt", 0, "do it");
		const e = j.recordTool({ ...obs(), toolCallId: "c1", output: "full output" });
		expect(e.evt).toBe(2);
		expect(j.raw(2)).toBe("full output");
		const j2 = new Journal(dir);
		expect(j2.events).toHaveLength(2);
		expect(j2.forCall("c1")?.evt).toBe(2);
		expect(j2.nextEvt()).toBe(3);
		expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
	});
	it("does not overwrite an existing journal gitignore", () => {
		const dir = mkdtempSync(join(tmpdir(), "baton-"));
		writeFileSync(join(dir, ".gitignore"), "keep\n");
		new Journal(dir);
		expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("keep\n");
	});
	it("scopes prompts to a session directory and reloads that session only", () => {
		const dir = mkdtempSync(join(tmpdir(), "baton-"));
		const first = new Journal(dir, { sessionId: "sess-a" });
		first.record("user_prompt", 0, "first task");
		first.record("note", 1, "gate", { gate: { finalize: true } });
		const second = new Journal(dir, { sessionId: "sess-b" });
		expect(second.events).toEqual([]);
		second.record("user_prompt", 0, "second task");
		expect(second.events.map((e) => e.text)).toEqual(["second task"]);
		const resumed = new Journal(dir, { sessionId: "sess-a" });
		expect(resumed.events.map((e) => e.text)).toEqual(["first task", "gate"]);
		expect(resumed.dir).toBe(join(dir, "sessions", "sess-a"));
		expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
	});
	it("hides earlier events after a fresh session marker when there is no session id", () => {
		const dir = mkdtempSync(join(tmpdir(), "baton-"));
		const old = new Journal(dir);
		old.record("user_prompt", 0, "ancient");
		const cur = new Journal(dir, { freshMarker: true });
		expect(cur.events.map((e) => e.kind)).toEqual(["session_start"]);
		expect(cur.get(1)).toBeUndefined();
		cur.record("user_prompt", 1, "now");
		expect(cur.events.some((e) => e.text === "ancient")).toBe(false);
		const next = new Journal(dir, { freshMarker: true });
		expect(next.events.map((e) => e.text)).toEqual(["session_start"]);
		expect(next.events.some((e) => e.text === "now" || e.text === "ancient")).toBe(false);
		const whole = new Journal(dir);
		expect(whole.events.some((e) => e.text === "ancient")).toBe(true);
	});
});
