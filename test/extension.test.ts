import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import baton from "../src/pi/index.ts";

const PLAN = JSON.stringify({
	verdict: "on_track",
	facts_corrected: [],
	plan: [{ id: "S1", action: "implement the widget", done_when: "tests pass", verify: "self" }],
	do_not_retry: [],
	test_cmd: null,
});
const REVIEW_OK = JSON.stringify({ verdict: "on_track", facts_corrected: [], plan: [], do_not_retry: [], test_cmd: null });
const REVIEW_FIX = JSON.stringify({
	verdict: "course_correct",
	facts_corrected: [],
	plan: [{ id: "S9", action: "fix the failing test", done_when: "vitest passes", verify: "review" }],
	do_not_retry: [],
	test_cmd: null,
});
const DONE = JSON.stringify({ verdict: "done", facts_corrected: [], plan: [], do_not_retry: [], test_cmd: null });

const agentDir = mkdtempSync(join(tmpdir(), "baton-agent-"));
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => {
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterAll(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
});

function gitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "baton-ext-"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
	git("init", "-q");
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	git("add", ".");
	git("commit", "-qm", "init");
	return dir;
}

function contextText(context: { systemPrompt?: string; messages?: { content?: unknown }[] }): string {
	const parts = [context.systemPrompt ?? ""];
	for (const message of context.messages ?? []) {
		const content = message.content;
		if (typeof content === "string") parts.push(content);
		else if (Array.isArray(content)) for (const part of content) if (part && typeof part === "object" && "text" in part) parts.push(String((part as { text?: unknown }).text ?? ""));
	}
	return parts.join("\n");
}

function mount(dir: string, replyFor: (text: string) => string) {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<any> }>();
	const advisorTexts: string[] = [];
	const pings = { n: 0 };
	let sessionId = "sess-a";
	const ctx = {
		cwd: dir,
		hasUI: false,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => sessionId },
		getContextUsage: () => ({ tokens: 100, contextWindow: 200_000, percent: 0 }),
		modelRegistry: {
			find: () => ({ id: "advisor", provider: "openrouter" }),
			complete: async (_model: unknown, context: { systemPrompt?: string; messages?: { content?: unknown }[] }) => {
				const text = contextText(context);
				if (text.includes("Cache keepalive")) {
					pings.n += 1;
					return { content: [{ type: "text", text: "{}" }], stopReason: "stop", usage: { input: 1, output: 1 } };
				}
				advisorTexts.push(text);
				return { content: [{ type: "text", text: replyFor(text) }], stopReason: "stop", usage: { input: 10, output: 4 } };
			},
		},
	};
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<any> }) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		exec(command: string, args: string[]) {
			return new Promise((resolve) => {
				execFile(command, args, { cwd: dir }, (err, stdout, stderr) => {
					const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
					resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
				});
			});
		},
	};
	baton(pi as any);
	const emit = async (event: string, payload: unknown) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
		return result;
	};
	return {
		ctx,
		tools,
		advisorTexts,
		pings,
		emit,
		setSession(id: string) {
			sessionId = id;
		},
	};
}

async function prompt(h: ReturnType<typeof mount>, text: string) {
	await h.emit("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: text, systemPrompt: "", systemPromptOptions: {} });
}

async function tool(h: ReturnType<typeof mount>, toolName: string, input: Record<string, unknown>, output: string, isError = false) {
	const id = `c${h.advisorTexts.length}-${toolName}-${Math.random().toString(16).slice(2)}`;
	const call = await h.emit("tool_call", { type: "tool_call", toolCallId: id, toolName, input });
	await h.emit("tool_result", {
		type: "tool_result",
		toolCallId: id,
		toolName,
		input,
		content: [{ type: "text", text: output }],
		isError,
		structuredContent: toolName === "bash" ? { exit_code: isError ? 1 : 0 } : undefined,
	});
	return call;
}

const FAIL_OUT = "FAIL test/a.test.ts > adds numbers\nAssertionError: expected 1 to be 2\n";

describe("pi extension wiring", () => {
	it("reviews the current task and blocks commit until the review passes", async () => {
		const dir = gitRepo();
		const h = mount(dir, (text) => (text.includes('kind="plan"') ? PLAN : REVIEW_OK));
		try {
			await h.emit("session_start", { type: "session_start", reason: "startup" });
			await prompt(h, "Ship the widget");
			await tool(h, "read", { path: "a.ts" }, "export const a = 1;\n");
			await tool(h, "bash", { command: "ls" }, "a.ts\n");
			await tool(h, "bash", { command: "pwd" }, dir);
			const plan = await h.tools.get("baton_plan")!.execute("t-plan", {}, undefined, undefined, h.ctx);
			expect(plan.details.ok).toBe(true);
			await prompt(h, "also paint it blue");
			const step = await h.tools.get("baton_step")!.execute("t-step", { id: "S1", status: "done", evidence: "tests pass" }, undefined, undefined, h.ctx);
			expect(step.details).toMatchObject({ ok: true, step: "S1", status: "done" });
			const blocked = await h.emit("tool_call", { type: "tool_call", toolCallId: "commit-1", toolName: "bash", input: { command: "git commit -m widget" } });
			expect(blocked).toMatchObject({ block: true });
			expect(String((blocked as { reason?: string }).reason)).toMatch(/baton_review/);
			const review = await h.tools.get("baton_review")!.execute("t-review", {}, undefined, undefined, h.ctx);
			expect(review.details).toMatchObject({ ok: true, verdict: "on_track" });
			const allowed = await h.emit("tool_call", { type: "tool_call", toolCallId: "commit-2", toolName: "bash", input: { command: "git commit -m widget" } });
			expect(allowed).toBeUndefined();
			const packs = h.advisorTexts.filter((t) => t.includes("TASK (verbatim)"));
			expect(packs.length).toBeGreaterThanOrEqual(2);
			for (const pack of packs) expect(pack).toMatch(/## TASK \(verbatim\)\nShip the widget/);
			expect(packs[0]).not.toContain("also paint it blue");
			expect(packs.at(-1)).toContain("also paint it blue");
		} finally {
			await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		}
	});

	it("does not restore another session's prompts, gate, or deferred items", async () => {
		const dir = gitRepo();
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi", "baton.json"), JSON.stringify({ loop: { maxHops: 1 }, triggers: { planBeforeWrite: false } }));
		const h = mount(dir, () => REVIEW_FIX);
		try {
			await h.emit("session_start", { type: "session_start", reason: "startup" });
			await prompt(h, "OLD_TASK_ALPHA");
			await tool(h, "bash", { command: "npx vitest run" }, FAIL_OUT, true);
			await tool(h, "write", { path: "src/a.ts", content: "x" }, "wrote");
			await tool(h, "bash", { command: "npx vitest run" }, FAIL_OUT, true);
			const deferredEdit = await h.emit("tool_call", { type: "tool_call", toolCallId: "edit-a", toolName: "write", input: { path: "test/a.test.ts", content: "nope" } });
			expect(String((deferredEdit as { reason?: string } | undefined)?.reason)).toMatch(/deferred/);
			const review = await h.tools.get("baton_review")!.execute("rev-a", {}, undefined, undefined, h.ctx);
			expect(review.details.ok).toBe(true);
			expect(h.advisorTexts.at(-1)).toMatch(/## TASK \(verbatim\)\nOLD_TASK_ALPHA/);
			const refused = await h.tools.get("baton_review")!.execute("rev-a2", {}, undefined, undefined, h.ctx);
			expect(refused.details.refused).toBe(true);
			const pinned = JSON.stringify(await h.emit("context", { type: "context", messages: [{ role: "user", content: "hello" }] }));
			expect(pinned).toContain("DEFERRED");
			await h.emit("session_shutdown", { type: "session_shutdown", reason: "new" });

			h.setSession("sess-b");
			await h.emit("session_start", { type: "session_start", reason: "new" });
			await prompt(h, "NEW_TASK_BETA");
			await prompt(h, "FOLLOW_UP_BETA");
			const freshEdit = await h.emit("tool_call", { type: "tool_call", toolCallId: "edit-b", toolName: "write", input: { path: "test/a.test.ts", content: "ok" } });
			expect(freshEdit).toBeUndefined();
			const freshPin = JSON.stringify(await h.emit("context", { type: "context", messages: [{ role: "user", content: "hello" }] }));
			expect(freshPin).not.toContain("DEFERRED");
			const again = await h.tools.get("baton_review")!.execute("rev-b", {}, undefined, undefined, h.ctx);
			expect(again.details.refused).not.toBe(true);
			expect(again.details.ok).toBe(true);
			const beta = h.advisorTexts.at(-1)!;
			expect(beta).toMatch(/## TASK \(verbatim\)\nNEW_TASK_BETA/);
			expect(beta).toContain("FOLLOW_UP_BETA");
			expect(beta).not.toContain("OLD_TASK_ALPHA");
			await h.emit("session_shutdown", { type: "session_shutdown", reason: "resume" });

			h.setSession("sess-a");
			await h.emit("session_start", { type: "session_start", reason: "resume" });
			const restored = await h.emit("tool_call", { type: "tool_call", toolCallId: "edit-a2", toolName: "write", input: { path: "test/a.test.ts", content: "still" } });
			expect(String((restored as { reason?: string } | undefined)?.reason)).toMatch(/deferred/);
			const stillRefused = await h.tools.get("baton_review")!.execute("rev-a3", {}, undefined, undefined, h.ctx);
			expect(stillRefused.details.refused).toBe(true);
			const restoredPin = JSON.stringify(await h.emit("context", { type: "context", messages: [{ role: "user", content: "hello" }] }));
			expect(restoredPin).toContain("DEFERRED");
			expect(existsSync(join(dir, ".pi/baton/sessions/sess-a/events.jsonl"))).toBe(true);
			expect(existsSync(join(dir, ".pi/baton/sessions/sess-b/events.jsonl"))).toBe(true);
			expect(readFileSync(join(dir, ".pi/baton/sessions/sess-a/events.jsonl"), "utf8")).toContain("OLD_TASK_ALPHA");
			expect(readFileSync(join(dir, ".pi/baton/sessions/sess-a/events.jsonl"), "utf8")).not.toContain("NEW_TASK_BETA");
			expect(readFileSync(join(dir, ".pi/baton/.gitignore"), "utf8")).toBe("*\n");
		} finally {
			await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		}
	});

	it("stops advisor keepalive after a done verdict and on shutdown", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const dir = gitRepo();
		let mode = "plan";
		const h = mount(dir, (text) => (mode === "done" ? DONE : text.includes('kind="plan"') ? PLAN : REVIEW_OK));
		try {
			await h.emit("session_start", { type: "session_start", reason: "startup" });
			await prompt(h, "Keep the cache warm");
			const plan = await h.tools.get("baton_plan")!.execute("ka-plan", {}, undefined, undefined, h.ctx);
			expect(plan.details.ok).toBe(true);
			await vi.advanceTimersByTimeAsync(250_000);
			expect(h.pings.n).toBeGreaterThan(0);
			const afterPlan = h.pings.n;
			mode = "done";
			const review = await h.tools.get("baton_review")!.execute("ka-review", {}, undefined, undefined, h.ctx);
			expect(review.details).toMatchObject({ ok: true, verdict: "done" });
			await vi.advanceTimersByTimeAsync(1_000_000);
			expect(h.pings.n).toBe(afterPlan);

			await h.emit("session_shutdown", { type: "session_shutdown", reason: "new" });
			h.setSession("sess-later");
			mode = "plan";
			await h.emit("session_start", { type: "session_start", reason: "new" });
			await prompt(h, "A later session");
			await h.tools.get("baton_plan")!.execute("ka-plan-2", {}, undefined, undefined, h.ctx);
			await vi.advanceTimersByTimeAsync(500_000);
			await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
			const stopped = h.pings.n;
			expect(stopped).toBeGreaterThan(afterPlan);
			await vi.advanceTimersByTimeAsync(1_000_000);
			expect(h.pings.n).toBe(stopped);
		} finally {
			await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
			vi.useRealTimers();
		}
	});
});
