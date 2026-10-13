import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HELPER_INSTRUCTION_TYPE, LEAD_NOTE_TYPE } from "../src/context.ts";
import baton from "../src/index.ts";
import { gitRepo } from "./helpers.ts";

const LEAD = "anthropic/claude-opus-5.5";
const HELPER = "z-ai/glm-5.3-flash";
const agentDir = mkdtempSync(join(tmpdir(), "baton-agent-"));
const savedEnv = { ...process.env };

beforeAll(() => {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.BATON_JEV = "0";
	delete process.env.BATON_BUDGET_USD;
});
afterAll(() => {
	process.env = savedEnv;
});

const PROJECT = {
	"package.json": JSON.stringify({
		scripts: {
			test: `node -e "process.exit(require('fs').readFileSync('src/model.ts','utf8').includes('broken') ? 1 : 0)"`,
			build: `node -e "if (!require('fs').readFileSync('vite.config.js','utf8').includes('jsx')) { console.error('error: JSX syntax extension is not enabled'); process.exit(1) }"`,
		},
	}),
	"src/model.ts": "export const model = 1;\n",
	"vite.config.js": "export default { jsx: true };\n",
};

type Handler = (event: unknown, ctx: unknown) => unknown;

function mount(cwd: string) {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>();
	const models: string[] = [];
	let aborted = 0;
	const ctx = {
		cwd,
		hasUI: false,
		ui: { notify() {} },
		model: undefined as { id: string; provider: string } | undefined,
		signal: undefined,
		sessionManager: { getSessionId: () => "session-1" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		abort: () => aborted++,
	};
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }) {
			tools.set(tool.name, tool);
		},
		async setModel(model: { id: string; provider: string }) {
			ctx.model = model;
			models.push(model.id);
			return true;
		},
	};
	baton(pi as never);
	const emit = async (event: string, payload: unknown): Promise<any> => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
		return result;
	};
	let callCounter = 0;
	const turn = (model: string, calls: { name: string; args: Record<string, unknown>; output?: string; isError?: boolean }[], text = "") => {
		const withIds = calls.map((call) => ({ ...call, id: `call-${++callCounter}` }));
		return emit("turn_end", {
			message: { role: "assistant", model, stopReason: withIds.length ? "toolUse" : "stop", content: [...(text ? [{ type: "text", text }] : []), ...withIds.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.args }))] },
			toolResults: withIds.filter((call) => call.output !== undefined).map((call) => ({ toolCallId: call.id, isError: !!call.isError, content: [{ type: "text", text: call.output }] })),
		});
	};
	return { ctx, tools, models, emit, turn, aborted: () => aborted };
}

async function startTask(h: ReturnType<typeof mount>, prompt = "Build tetris") {
	await h.emit("session_start", { reason: "startup" });
	return h.emit("before_agent_start", { messageType: "user", prompt, systemPrompt: "BASE PROMPT", systemPromptOptions: {} });
}

describe("speculative execution in a pi session", () => {
	it("runs the helper after a lead turn, reports facts with harness checks, and rolls back on request", async () => {
		const cwd = gitRepo(PROJECT);
		const h = mount(cwd);
		const start = await startTask(h);
		expect(start.systemPrompt).toMatch(/^BASE PROMPT\n\n# Baton: speculative execution/);
		expect(h.ctx.model?.id).toBe(LEAD);

		const handoff = await h.turn(LEAD, [{ name: "read", args: { path: "src/model.ts" }, output: "export const model = 1;\n" }]);
		expect(handoff.entries).toHaveLength(1);
		expect(handoff.entries[0]).toMatchObject({ customType: HELPER_INSTRUCTION_TYPE });
		expect(handoff.entries[0].content).toMatch(/Speculative run #1[\s\S]*read src\/model\.ts/);
		expect(h.ctx.model?.id).toBe(HELPER);

		writeFileSync(join(cwd, "src/model.ts"), "export const model = 'broken';\n");
		expect(await h.turn(HELPER, [{ name: "edit", args: { path: "src/model.ts", oldText: "1", newText: "'broken'" }, output: "Edited src/model.ts" }], "Updating the model.")).toBeUndefined();
		const back = await h.turn(HELPER, [], "All checks are green, the model is done.");
		expect(back.continue).toBe(true);
		expect(h.ctx.model?.id).toBe(LEAD);
		const note: string = back.entries[0].content;
		expect(back.entries[0].customType).toBe(LEAD_NOTE_TYPE);
		expect(note).toMatch(/Speculative run #1 — performed by the helper model \(glm-5\.3-flash\), not by you/);
		expect(note).toMatch(/2 turn\(s\), 1 tool call\(s\)\. It stopped because the helper stopped calling tools/);
		expect(note).toContain("- modified src/model.ts");
		expect(note).toContain("+export const model = 'broken';");
		expect(note).toMatch(/test: `npm test --silent` → FAIL/);
		expect(note).toMatch(/build: `npm run -s build` → PASS/);
		expect(note).toContain("baton_rollback({run: 1})");
		expect(note).not.toMatch(/All checks are green|Updating the model/);

		const leadView = await h.emit("context", {
			messages: [
				{ role: "assistant", model: LEAD, content: [{ type: "toolCall", id: "l" }], timestamp: 1 },
				{ role: "custom", customType: HELPER_INSTRUCTION_TYPE, content: "instruction", timestamp: 2 },
				{ role: "assistant", model: HELPER, content: [{ type: "toolCall", id: "h" }], timestamp: 3 },
				{ role: "toolResult", toolCallId: "h", content: [], timestamp: 4 },
				{ role: "custom", customType: LEAD_NOTE_TYPE, content: note, timestamp: 5 },
			],
		});
		expect(leadView.messages.map((message: { role: string }) => message.role)).toEqual(["assistant", "custom"]);

		const rollback = await h.tools.get("baton_rollback")!.execute("t", {});
		expect(rollback.content[0]!.text).toMatch(/run #1 rolled back[\s\S]*Restored: src\/model\.ts/);
		expect(readFileSync(join(cwd, "src/model.ts"), "utf8")).toBe("export const model = 1;\n");
		expect(await h.turn(LEAD, [{ name: "baton_rollback", args: {}, output: "rolled back" }])).toBeUndefined();
		expect(await h.turn(LEAD, [], "Done.")).toBeUndefined();

		await h.emit("agent_end", {});
		const summary = JSON.parse(readFileSync(join(cwd, ".pi/baton/sessions/session-1/summary.json"), "utf8"));
		expect(summary.stats).toMatchObject({ runs: 1, helperTurns: 2, rollbacks: 1 });
		expect(readFileSync(join(cwd, ".pi/baton/.gitignore"), "utf8")).toBe("*\n");
	});

	it("ends the run when a guardrail blocks the helper, then respects the cooldown", async () => {
		const cwd = gitRepo(PROJECT);
		const h = mount(cwd);
		await startTask(h);
		await h.turn(LEAD, [{ name: "bash", args: { command: "ls" }, output: "src" }]);
		const blocked = await h.emit("tool_call", { toolCallId: "w1", toolName: "write", input: { path: "src/model.ts", content: "rewritten" } });
		expect(blocked).toMatchObject({ block: true });
		expect(blocked.reason).toMatch(/overwrites the existing file src\/model\.ts/);
		const sameTurn = await h.emit("tool_call", { toolCallId: "w2", toolName: "read", input: { path: "src/model.ts" } });
		expect(sameTurn.reason).toMatch(/run already ended/);
		const back = await h.emit("turn_end", {
			message: { role: "assistant", model: HELPER, stopReason: "toolUse", content: [{ type: "toolCall", id: "w1", name: "write", arguments: { path: "src/model.ts", content: "rewritten" } }] },
			toolResults: [{ toolCallId: "w1", isError: true, content: [{ type: "text", text: "blocked" }] }],
		});
		expect(back.entries[0].content).toMatch(/It stopped because guardrail blocked write: overwrites the existing file/);
		expect(back.entries[0].content).toMatch(/write src\/model\.ts → ERROR — blocked by Baton/);
		expect(back.entries[0].content).toMatch(/the run changed no files/);
		expect(await h.turn(LEAD, [{ name: "read", args: { path: "a" }, output: "x" }])).toBeUndefined();
		expect(h.ctx.model?.id).toBe(LEAD);
		const next = await h.turn(LEAD, [{ name: "read", args: { path: "b" }, output: "y" }]);
		expect(next.entries[0].content).toMatch(/Speculative run #2/);
	});

	it("runs final checks when the lead finishes and sends it back while they fail", async () => {
		const cwd = gitRepo(PROJECT);
		writeFileSync(join(agentDir, "baton.json"), JSON.stringify({ speculate: false }));
		try {
			const h = mount(cwd);
			await startTask(h);
			writeFileSync(join(cwd, "vite.config.js"), "export default {};\n");
			expect(await h.turn(LEAD, [{ name: "write", args: { path: "vite.config.js", content: "export default {};\n" }, output: "ok" }])).toBeUndefined();
			const sentBack = await h.turn(LEAD, [], "Done.");
			expect(sentBack.continue).toBe(true);
			expect(sentBack.entries[0].content).toMatch(/Final checks — run by the harness after your final answer \(round 1 of 2\)\. 1 of 2 failed/);
			expect(sentBack.entries[0].content).toMatch(/JSX syntax extension is not enabled/);
			writeFileSync(join(cwd, "vite.config.js"), "export default { jsx: true, minify: true };\n");
			expect(await h.turn(LEAD, [], "Fixed.")).toBeUndefined();
			expect(await h.turn(LEAD, [], "Still done.")).toBeUndefined();
		} finally {
			writeFileSync(join(agentDir, "baton.json"), "{}");
		}
	});

	it("keeps budget for the lead's wrap-up, then stops at the budget", async () => {
		const cwd = gitRepo(PROJECT);
		writeFileSync(join(agentDir, "baton.json"), JSON.stringify({ budget: { usd: 1 }, checks: { final: false } }));
		try {
			const h = mount(cwd);
			await startTask(h);
			await h.emit("message_end", { message: { role: "assistant", model: LEAD, usage: { cost: { total: 0.45 } } } });
			const wrapUp = await h.turn(LEAD, [{ name: "read", args: { path: "src/model.ts" }, output: "x" }]);
			expect(wrapUp.entries).toHaveLength(1);
			expect(wrapUp.entries[0].content).toMatch(/Budget: about \$0\.45 of \$1\.00 is spent\. No more speculative runs/);
			expect(h.ctx.model?.id).toBe(LEAD);
			expect(h.aborted()).toBe(0);
			await h.emit("message_end", { message: { role: "assistant", model: LEAD, usage: { cost: { total: 0.6 } } } });
			expect(h.aborted()).toBe(1);
			await h.emit("before_agent_start", { messageType: "user", prompt: "more", systemPrompt: "", systemPromptOptions: {} });
			expect(h.aborted()).toBe(2);
		} finally {
			writeFileSync(join(agentDir, "baton.json"), "{}");
		}
	});

	it("asks Jev with recent turns of both models and skips the run on a low probability", async () => {
		const requests: { state: { recent_turns: string[]; proposed_call: { call: string } } }[] = [];
		const answers = [0.95, 0.2];
		vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
			requests.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ model: "typesafe/jev-1.13", answers: { more_calls: { type: "noul", noul: answers.shift() } }, usage: { cost: 0.001 } }));
		});
		process.env.BATON_JEV = "1";
		process.env.OPENROUTER_API_KEY = "test-key";
		try {
			const h = mount(gitRepo(PROJECT));
			await startTask(h);
			const run = await h.turn(LEAD, [{ name: "read", args: { path: "src/model.ts" }, output: "export const model = 1;" }]);
			expect(run.entries[0].customType).toBe(HELPER_INSTRUCTION_TYPE);
			await h.turn(HELPER, [{ name: "bash", args: { command: "npm test" }, output: "ok" }]);
			await h.turn(HELPER, []);
			await h.turn(LEAD, [{ name: "read", args: { path: "a" }, output: "cooldown turn" }]);
			expect(requests).toHaveLength(1);
			expect(await h.turn(LEAD, [{ name: "read", args: { path: "vite.config.js" }, output: "jsx" }])).toBeUndefined();
			expect(requests).toHaveLength(2);
			const state = requests[1]!.state;
			expect(state.recent_turns.join("\n")).toMatch(/\[helper\] bash: npm test => ok[\s\S]*\[lead\] read a => ok/);
			expect(state.proposed_call.call).toMatch(/\[lead\] read vite\.config\.js/);
			expect(h.ctx.model?.id).toBe(LEAD);
		} finally {
			vi.unstubAllGlobals();
			process.env.BATON_JEV = "0";
			delete process.env.OPENROUTER_API_KEY;
		}
	});

	it("closes an unfinished run when a new prompt arrives", async () => {
		const h = mount(gitRepo(PROJECT));
		await startTask(h);
		await h.turn(LEAD, [{ name: "read", args: { path: "src/model.ts" }, output: "x" }]);
		expect(h.ctx.model?.id).toBe(HELPER);
		const next = await h.emit("before_agent_start", { messageType: "user", prompt: "Also add a score", systemPrompt: "", systemPromptOptions: {} });
		expect(h.ctx.model?.id).toBe(LEAD);
		expect(next.message).toMatchObject({ customType: LEAD_NOTE_TYPE });
		expect(next.message.content).toMatch(/Speculative run #1[\s\S]*stopped because a new prompt arrived/);
	});

	it("works outside git without checkpoints", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "baton-nogit-"));
		const h = mount(cwd);
		await startTask(h);
		await h.turn(LEAD, [{ name: "read", args: { path: "a" }, output: "x" }]);
		const back = await h.turn(HELPER, [], "");
		expect(back.entries[0].content).toMatch(/Checkpoint: none \(not a git repository\)/);
		const rollback = await h.tools.get("baton_rollback")!.execute("t", {});
		expect(rollback.content[0]!.text).toMatch(/has no checkpoint/);
		expect(existsSync(join(cwd, ".pi/baton/sessions/session-1/events.jsonl"))).toBe(true);
	});
});
