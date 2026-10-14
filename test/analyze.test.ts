import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSessionFile, renderComparisonReport, renderHumanReport, resolveSessionFiles } from "../scripts/analyze-session.ts";

function createSyntheticSession(): string {
	const dir = mkdtempSync(join(tmpdir(), "baton-analyze-"));
	const sessionsDir = join(dir, ".pi", "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const sessionPath = join(sessionsDir, "2026-10-13T21-00-00-000Z_test-session.jsonl");

	const entries = [
		{ type: "session", version: 3, id: "test-session", timestamp: "2026-10-13T21:00:00.000Z", cwd: dir },
		{ type: "session_info", id: "info-1", parentId: null, timestamp: "2026-10-13T21:00:00.010Z", name: "synthetic-baton" },
		{
			type: "message",
			id: "sys-1",
			timestamp: "2026-10-13T21:00:00.020Z",
			message: { role: "system", content: "# Baton: speculative runs\nSystem prompt text." },
		},
		{
			type: "message",
			id: "usr-1",
			timestamp: "2026-10-13T21:00:00.030Z",
			message: { role: "user", content: [{ type: "text", text: "Build feature X" }] },
		},
		{
			type: "message",
			id: "ast-1",
			timestamp: "2026-10-13T21:00:05.000Z",
			message: {
				role: "assistant",
				model: "anthropic/claude-opus-5.5",
				stopReason: "toolUse",
				durationMs: 4000,
				timestamp: Date.parse("2026-10-13T21:00:01.000Z"),
				usage: {
					input: 100,
					output: 200,
					cacheRead: 5000,
					cacheWrite: 0,
					totalTokens: 5300,
					cost: { input: 0.0005, output: 0.005, cacheRead: 0.0025, cacheWrite: 0, total: 0.008 },
				},
				content: [
					{ type: "thinking", thinking: "Let us inspect package.json" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "package.json" } },
				],
			},
		},
		{
			type: "message",
			id: "res-1",
			timestamp: "2026-10-13T21:00:05.010Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				isError: false,
				durationMs: 10,
				content: [{ type: "text", text: '{"name":"demo"}' }],
			},
		},
		{
			type: "custom_message",
			id: "helper-start-1",
			customType: "baton-helper",
			timestamp: "2026-10-13T21:00:05.020Z",
			content: "[Baton] Speculative run #1. You are now the helper model, not the lead.",
		},
		{
			type: "message",
			id: "ast-2",
			timestamp: "2026-10-13T21:00:07.020Z",
			message: {
				role: "assistant",
				model: "z-ai/glm-5.3-flash",
				stopReason: "toolUse",
				durationMs: 2000,
				timestamp: Date.parse("2026-10-13T21:00:05.020Z"),
				usage: {
					input: 500,
					output: 150,
					cacheRead: 5000,
					cacheWrite: 0,
					totalTokens: 5650,
					cost: { input: 0.0001, output: 0.0002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0004 },
				},
				content: [
					{ type: "toolCall", id: "call-2", name: "write", arguments: { path: "src/index.ts", content: "export const x = 1;" } },
					{ type: "toolCall", id: "call-3", name: "bash", arguments: { command: "bun test 2>&1 | tail -5" } },
				],
			},
		},
		{
			type: "message",
			id: "res-2",
			timestamp: "2026-10-13T21:00:07.025Z",
			message: {
				role: "toolResult",
				toolCallId: "call-2",
				toolName: "write",
				isError: false,
				durationMs: 5,
				content: [{ type: "text", text: "wrote src/index.ts" }],
			},
		},
		{
			type: "message",
			id: "res-3",
			timestamp: "2026-10-13T21:00:07.525Z",
			message: {
				role: "toolResult",
				toolCallId: "call-3",
				toolName: "bash",
				isError: false,
				durationMs: 500,
				content: [{ type: "text", text: "1 pass" }],
			},
		},
		{
			type: "message",
			id: "ast-3",
			timestamp: "2026-10-13T21:00:08.525Z",
			message: {
				role: "assistant",
				model: "z-ai/glm-5.3-flash",
				stopReason: "stop",
				durationMs: 1000,
				timestamp: Date.parse("2026-10-13T21:00:07.525Z"),
				usage: {
					input: 200,
					output: 30,
					cacheRead: 5500,
					cacheWrite: 0,
					totalTokens: 5730,
					cost: { input: 0.00005, output: 0.00005, cacheRead: 0.0001, cacheWrite: 0, total: 0.0002 },
				},
				content: [{ type: "text", text: "Done." }],
			},
		},
		{
			type: "custom_message",
			id: "lead-note-1",
			customType: "baton-lead",
			timestamp: "2026-10-13T21:00:08.530Z",
			content: [
				"[Baton] Speculative run #1 by the helper model (glm-5.3-flash), not by you. Its file changes are already on disk.",
				"It stopped because the helper ended its turn without tool calls: 2 turn(s), 2 tool call(s).",
				"",
				"Tool calls:",
				"1. write src/index.ts → ok",
				"2. bash `bun test 2>&1 | tail -5` → ok",
				"",
				"Files changed with edit/write (undo: baton_undo({run: 1})):",
				"- created src/index.ts (+1 −0)",
				"",
				"Continue from here: keep the run, fix it, or undo it.",
			].join("\n"),
		},
		{
			type: "message",
			id: "ast-4",
			timestamp: "2026-10-13T21:00:11.530Z",
			message: {
				role: "assistant",
				model: "anthropic/claude-opus-5.5",
				stopReason: "stop",
				durationMs: 3000,
				timestamp: Date.parse("2026-10-13T21:00:08.530Z"),
				usage: {
					input: 50,
					output: 100,
					cacheRead: 5200,
					cacheWrite: 400,
					totalTokens: 5750,
					cost: { input: 0.0002, output: 0.002, cacheRead: 0.0026, cacheWrite: 0.0025, total: 0.0073 },
				},
				content: [{ type: "text", text: "Feature X is complete." }],
			},
		},
	];

	writeFileSync(sessionPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return dir;
}

describe("session analyzer", () => {
	it("resolves a project directory to its session jsonl and computes rich statistics", () => {
		const projectDir = createSyntheticSession();
		const files = resolveSessionFiles([projectDir]);
		expect(files).toHaveLength(1);

		const analysis = analyzeSessionFile(files[0]!);
		expect(analysis.sessionId).toBe("test-session");
		expect(analysis.sessionName).toBe("synthetic-baton");
		expect(analysis.withBaton).toBe(true);
		expect(analysis.completedCleanly).toBe(true);
		expect(analysis.totalTurns).toBe(4);
		expect(analysis.leadTurns).toBe(2);
		expect(analysis.helperTurns).toBe(2);
		expect(analysis.totalToolCalls).toBe(3);
		expect(analysis.runs).toHaveLength(1);

		const run = analysis.runs[0]!;
		expect(run.runNumber).toBe(1);
		expect(run.finished).toBe(true);
		expect(run.turns).toBe(2);
		expect(run.toolCalls).toBe(2);
		expect(run.leadReaction).toBe("kept");
		expect(run.noteFiles).toEqual([{ kind: "created", path: "src/index.ts", added: 1, removed: 0 }]);
		expect(analysis.bashBreakdown.test.pipedChecks).toBe(1);

		const report = renderHumanReport(analysis, { showTurns: true, showCalls: true });
		expect(report).toContain("SESSION ANALYSIS: synthetic-baton");
		expect(report).toContain("BATON SPECULATIVE RUNS (1)");
		expect(report).toContain("ALL ASSISTANT TURNS (4)");
		expect(report).toContain("ALL TOOL CALLS (3)");

		const comparison = renderComparisonReport([analysis, analysis]);
		expect(comparison).toContain("MULTI-SESSION COMPARISON (2 runs)");
	});
});
