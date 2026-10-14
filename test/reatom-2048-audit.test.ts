import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditSession } from "../evals/reatom-2048/hidden/audit-session.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function withWorkspace(run: (cwd: string) => void) {
	const cwd = mkdtempSync(join(repoRoot, "tmp", "audit-unit-"));
	try {
		run(cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

function writeSession(cwd: string, lines: unknown[]) {
	const dir = join(cwd, ".pi", "sessions");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "x.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: args }],
			model: "test-model",
		},
	};
}

function toolResult(id: string, name: string, text: string) {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text }],
		},
	};
}

describe("reatom 2048 session audit", () => {
	it("accepts a clean session", () => {
		withWorkspace((cwd) => {
			writeSession(cwd, [
				toolCall("1", "bash", { command: "ls" }),
				toolResult("1", "bash", "src\n"),
				toolCall("2", "read", { path: "src/main.tsx" }),
				toolResult("2", "read", "export {}\n"),
			]);
			const result = auditSession(cwd);
			expect(result.ok).toBe(true);
			expect(result.violations).toEqual([]);
			expect(result.warnings).toEqual([]);
			expect(result.toolCalls).toBe(2);
			expect(result.sources).toEqual([".pi/sessions/x.jsonl"]);
		});
	});

	it("flags a read of the hidden suite", () => {
		withWorkspace((cwd) => {
			writeSession(cwd, [
				toolCall("1", "read", { path: "../../evals/reatom-2048/hidden/e2e.test.ts" }),
				toolResult("1", "read", "hidden"),
			]);
			const result = auditSession(cwd);
			expect(result.ok).toBe(false);
			expect(result.violations.some((item) => item.toolName === "read" && item.toolCallId === "1")).toBe(true);
			expect(result.violations.every((item) => item.excerpt.length <= 200)).toBe(true);
		});
	});

	it("flags a tool result that mentions the eval hook", () => {
		withWorkspace((cwd) => {
			writeSession(cwd, [
				toolCall("1", "bash", { command: "echo hi" }),
				toolResult("1", "bash", "saw window.__eval in the page"),
			]);
			const result = auditSession(cwd);
			expect(result.ok).toBe(false);
			expect(result.warnings).toEqual([]);
			expect(result.violations).toEqual([
				expect.objectContaining({
					toolCallId: "1",
					toolName: "bash",
					model: "test-model",
					reason: "hidden marker: window.__eval",
				}),
			]);
		});
	});

	it("warns when bash steps outside the workspace", () => {
		withWorkspace((cwd) => {
			writeSession(cwd, [
				toolCall("1", "bash", { command: "cat ../package.json" }),
				toolResult("1", "bash", "{}\n"),
			]);
			const result = auditSession(cwd);
			expect(result.ok).toBe(true);
			expect(result.violations).toEqual([]);
			expect(result.warnings).toEqual([
				expect.objectContaining({
					toolCallId: "1",
					toolName: "bash",
					reason: "bash path contains ..",
				}),
			]);
		});
	});

	it("skips when the workspace has no session logs", () => {
		const cwd = mkdtempSync(join(tmpdir(), "reatom-2048-audit-empty-"));
		try {
			expect(auditSession(cwd)).toEqual({
				ok: true,
				skipped: "no session logs",
				toolCalls: 0,
				violations: [],
				warnings: [],
				sources: [],
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
