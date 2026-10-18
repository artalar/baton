import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, envFlag, isSameModel, loadConfig } from "../src/config.ts";

function dirs(user?: object, project?: object) {
	const agent = mkdtempSync(join(tmpdir(), "baton-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "baton-cwd-"));
	if (user) writeFileSync(join(agent, "baton.json"), JSON.stringify(user));
	if (project) {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "baton.json"), JSON.stringify(project));
	}
	return { cwd, env: { PI_CODING_AGENT_DIR: agent } as NodeJS.ProcessEnv };
}

describe("config", () => {
	it("defaults to speculation on with a 10-turn cap and a lead cache keepalive just inside the 5-minute cache", () => {
		const { cwd, env } = dirs();
		expect(loadConfig(cwd, () => {}, env)).toEqual(DEFAULT_CONFIG);
		expect(DEFAULT_CONFIG).toMatchObject({ speculate: true, maxHelperTurns: 10, cacheKeepaliveMs: 290_000 });
	});

	it("a project file or BATON_CACHE_KEEPALIVE_MS sets the keepalive, 0 turns it off, and values out of range fall back to the default", () => {
		const { cwd, env } = dirs({ cacheKeepaliveMs: 240_000 }, { cacheKeepaliveMs: 120_000 });
		expect(loadConfig(cwd, () => {}, env).cacheKeepaliveMs).toBe(120_000);
		expect(loadConfig(cwd, () => {}, { ...env, BATON_CACHE_KEEPALIVE_MS: "0" }).cacheKeepaliveMs).toBe(0);

		const warnings: string[] = [];
		const tooOften = dirs(undefined, { cacheKeepaliveMs: 1_000 });
		expect(loadConfig(tooOften.cwd, (message) => warnings.push(message), tooOften.env).cacheKeepaliveMs).toBe(290_000);
		expect(loadConfig(cwd, (message) => warnings.push(message), { ...env, BATON_CACHE_KEEPALIVE_MS: "soon" }).cacheKeepaliveMs).toBe(120_000);
		expect(loadConfig(cwd, (message) => warnings.push(message), { ...env, BATON_CACHE_KEEPALIVE_MS: "7200000" }).cacheKeepaliveMs).toBe(290_000);
		expect(warnings).toEqual([
			"baton: cacheKeepaliveMs 1000 is neither 0 (off) nor 60000–3600000; using 290000",
			"baton: BATON_CACHE_KEEPALIVE_MS=soon is not a non-negative integer; ignoring it",
			"baton: cacheKeepaliveMs 7200000 is neither 0 (off) nor 60000–3600000; using 290000",
		]);
	});

	it("a project file cannot choose models or the journal; the user file can", () => {
		const warnings: string[] = [];
		const { cwd, env } = dirs({ helper: "openrouter/x/cheap" }, { lead: "openrouter/evil/costly", maxHelperTurns: 10 });
		const config = loadConfig(cwd, (message) => warnings.push(message), env);
		expect(config).toMatchObject({ lead: DEFAULT_CONFIG.lead, helper: "openrouter/x/cheap", maxHelperTurns: 10 });
		expect(warnings.join("\n")).toMatch(/ignoring lead/);
	});

	it("environment variables override files", () => {
		const { cwd, env } = dirs({ maxHelperTurns: 5 });
		const warnings: string[] = [];
		const config = loadConfig(cwd, (message) => warnings.push(message), { ...env, BATON_SPEC: "off", BATON_MAX_TURNS: "12", BATON_JOURNAL_DIR: "/tmp/elsewhere" });
		expect(config).toMatchObject({ speculate: false, maxHelperTurns: 12, journalDir: ".pi/baton" });
		expect(warnings.join("\n")).toMatch(/outside the working directory/);
	});

	it("the helper thinks at low by default; files or BATON_HELPER_THINKING set another level or inherit, unknown levels fall back", () => {
		expect(DEFAULT_CONFIG.helperThinking).toBe("low");
		const { cwd, env } = dirs({ helperThinking: "minimal" }, { helperThinking: "medium" });
		expect(loadConfig(cwd, () => {}, env).helperThinking).toBe("medium");
		expect(loadConfig(cwd, () => {}, { ...env, BATON_HELPER_THINKING: " Inherit " }).helperThinking).toBe("inherit");

		const warnings: string[] = [];
		expect(loadConfig(cwd, (message) => warnings.push(message), { ...env, BATON_HELPER_THINKING: "deep" }).helperThinking).toBe("low");
		expect(warnings).toEqual(['baton: helperThinking "deep" is none of inherit, off, minimal, low, medium, high, xhigh, max; using low']);
	});

	it("turns speculation off when lead and helper are the same model", () => {
		const { cwd, env } = dirs({ helper: "anthropic/claude-opus-5.5" });
		const warnings: string[] = [];
		expect(loadConfig(cwd, (message) => warnings.push(message), env).speculate).toBe(false);
		expect(warnings.join("\n")).toMatch(/same model/);
	});

	it("helpers", () => {
		expect(envFlag("X", { X: "Yes" })).toBe(true);
		expect(envFlag("X", { X: "maybe" })).toBeUndefined();
		expect(isSameModel("anthropic/claude-opus-5.5", "openrouter/anthropic/claude-opus-5.5")).toBe(true);
	});
});
