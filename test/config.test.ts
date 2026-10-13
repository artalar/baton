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
	it("defaults: speculation on, facts transcript, guardrails, checkpoints and harness checks on, no helper cost inflation", () => {
		const { cwd, env } = dirs();
		const config = loadConfig(cwd, () => {}, env);
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(config).toMatchObject({ speculate: true, transcript: "facts", guardrails: true, checkpoints: true, checks: { afterRun: true, final: true }, budget: { helperCostFactor: 1 } });
	});

	it("a project file cannot choose models, budget or journal; the user file can", () => {
		const warnings: string[] = [];
		const { cwd, env } = dirs({ helper: "openrouter/x/cheap", budget: { usd: 3 } }, { lead: "openrouter/evil/costly", steps: 4, jev: { model: "evil", threshold: 0.9 } });
		const config = loadConfig(cwd, (message) => warnings.push(message), env);
		expect(config.lead).toBe(DEFAULT_CONFIG.lead);
		expect(config.helper).toBe("openrouter/x/cheap");
		expect(config.budget.usd).toBe(3);
		expect(config.steps).toBe(4);
		expect(config.jev).toMatchObject({ model: DEFAULT_CONFIG.jev.model, threshold: 0.9 });
		expect(warnings.join("\n")).toMatch(/ignoring lead[\s\S]*ignoring jev\.model/);
	});

	it("environment variables override files", () => {
		const { cwd, env } = dirs();
		const warnings: string[] = [];
		const config = loadConfig(cwd, (message) => warnings.push(message), { ...env, BATON_SPEC: "off", BATON_STEPS: "4", BATON_TRANSCRIPT: "full", BATON_CHECKS: "0", BATON_JEV: "no", BATON_BUDGET_USD: "abc", BATON_JOURNAL_DIR: "/tmp/elsewhere" });
		expect(config).toMatchObject({ speculate: false, steps: 4, transcript: "full", checks: { afterRun: false, final: false }, jev: { enabled: false }, budget: { usd: 0 }, journalDir: ".pi/baton" });
		expect(warnings.join("\n")).toMatch(/BATON_BUDGET_USD=abc[\s\S]*outside the working directory/);
	});

	it("helpers", () => {
		expect(envFlag("X", { X: "Yes" })).toBe(true);
		expect(envFlag("X", { X: "maybe" })).toBeUndefined();
		expect(isSameModel("anthropic/claude-opus-5.5", "openrouter/anthropic/claude-opus-5.5")).toBe(true);
	});
});
