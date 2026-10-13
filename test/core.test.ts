import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ChatMessage, runAdvisor } from "../src/core/advisor.ts";
import { collectPackInput } from "../src/core/pack/collect.ts";
import { buildReviewPack } from "../src/core/pack/index.ts";
import { buildOpenRouterRequest, openRouterComplete, openRouterModelId, supportsCacheControl } from "../src/core/openrouter.ts";
import { parseArgs } from "../src/cli/baton-pack.ts";
import { toPiContext } from "../src/pi/advisor.ts";
import { DEFAULT_CONFIG } from "../src/pi/config.ts";
import { systemSnippet } from "../src/pi/index.ts";

const GOOD = JSON.stringify({ verdict: "done", facts_corrected: [], plan: [], do_not_retry: [], test_cmd: null });

function repo(): string {
	const d = mkdtempSync(join(tmpdir(), "baton-core-"));
	const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d });
	g("init", "-q");
	writeFileSync(join(d, "AGENTS.md"), "Use reatom atoms.");
	mkdirSync(join(d, ".agents/skills/reatom"), { recursive: true });
	writeFileSync(join(d, ".agents/skills/reatom/SKILL.md"), "---\nname: reatom\ndescription: reatom state\n---\nNever use setTimeout.");
	writeFileSync(join(d, "a.ts"), "export const a = 1;\n");
	g("add", ".");
	g("commit", "-qm", "init");
	writeFileSync(join(d, "a.ts"), "import { atom } from 'reatom';\nexport const a = atom(1);\n");
	return d;
}

describe("buildReviewPack (pi-independent)", () => {
	const input = {
		kind: "review" as const,
		task: "TASK",
		userPrompts: [],
		previousPlan: "PLAN",
		diff: "+x",
		claims: ["all tests pass"],
		agentsMd: "AGENTS",
		skills: [{ name: "reatom", path: "p", body: "SKILL" }],
	};
	it("splits a stable cacheable system prefix (role, skills, AGENTS.md) from the per-call user message", () => {
		const p = buildReviewPack(input);
		expect(p.messages.map((m) => m.role)).toEqual(["system", "user"]);
		expect(p.messages[0]!.cache).toBe(true);
		const sys = p.messages[0]!.content;
		expect(sys.indexOf("## ROLE")).toBeLessThan(sys.indexOf("PROJECT SKILLS"));
		expect(sys.indexOf("PROJECT SKILLS")).toBeLessThan(sys.indexOf("AGENTS.md"));
		expect(sys).not.toContain("TASK");
		expect(sys).toContain("senior advisor"); // 0.11: shared role; the kind role is in the user message
		expect(sys).toContain("NO tools and everything you need is below");
		expect(p.sections.filter((s) => s.stable).map((s) => s.title)).toEqual(["ROLE", "PROJECT SKILLS (rules to check against)", "PROJECT RULES (AGENTS.md)"]);
		expect(p.stableTokens).toBeLessThan(p.tokens);
	});
	it("orders plan → task → artefacts → unverified claims → instructions + schema", () => {
		const u = buildReviewPack(input).messages[1]!.content;
		const at = (s: string) => u.indexOf(s);
		expect(at("PINNED PLAN")).toBeLessThan(at("TASK (verbatim)"));
		expect(at("TASK (verbatim)")).toBeLessThan(at("## GIT DIFF"));
		expect(at("## GIT DIFF")).toBeLessThan(at("EXECUTOR CLAIMS (unverified)"));
		expect(at("EXECUTOR CLAIMS (unverified)")).toBeLessThan(at("## INSTRUCTIONS"));
		expect(u.lastIndexOf('"verdict"')).toBeGreaterThan(at("## INSTRUCTIONS"));
	});
	it("stable prefix is identical across calls with different work", () => {
		const a = buildReviewPack(input).messages[0]!.content;
		const b = buildReviewPack({ ...input, task: "OTHER", diff: "+y", claims: [] }).messages[0]!.content;
		expect(a).toBe(b);
	});
});

describe("collectPackInput", () => {
	it("collects diff, changed files, AGENTS.md and relevant skills from a git repo", async () => {
		const d = repo();
		const i = await collectPackInput({ kind: "review", cwd: d, task: "make a reactive with reatom", claims: ["done"] });
		expect(i.diff).toContain("+export const a = atom(1);");
		expect(i.changedFiles?.map((f) => f.path)).toEqual(["a.ts"]);
		expect(i.agentsMd).toBe("Use reatom atoms.");
		expect(i.skills?.map((s) => s.name)).toEqual(["reatom"]);
		expect(i.claims).toEqual(["done"]);
		const p = buildReviewPack(i);
		expect(p.messages[0]!.content).toContain("Never use setTimeout.");
	});
});

describe("OpenRouter client", () => {
	const msgs: ChatMessage[] = [
		{ role: "system", content: "PREFIX", cache: true },
		{ role: "user", content: "WORK" },
	];
	it("marks the cacheable prefix with cache_control for Anthropic models only", () => {
		const r = buildOpenRouterRequest(msgs, { model: "anthropic/claude-opus-5.5", maxTokens: 100 }) as any;
		expect(r.model).toBe("anthropic/claude-opus-5.5");
		expect(r.max_tokens).toBe(100);
		expect(r.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "PREFIX", cache_control: { type: "ephemeral" } }] });
		expect(r.messages[1]).toEqual({ role: "user", content: "WORK" });
		const long = buildOpenRouterRequest(msgs, { model: "anthropic/x", cacheTtl: "1h" }) as any;
		expect(long.messages[0].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		const other = buildOpenRouterRequest(msgs, { model: "openai/gpt-x" }) as any;
		expect(other.messages[0]).toEqual({ role: "system", content: "PREFIX" });
		const off = buildOpenRouterRequest(msgs, { model: "anthropic/x", cache: false }) as any;
		expect(off.messages[0].content).toBe("PREFIX");
		expect(supportsCacheControl("anthropic/claude-opus-5.5")).toBe(true);
		expect(openRouterModelId("openrouter/anthropic/claude-opus-5.5")).toBe("anthropic/claude-opus-5.5");
	});
	it("sends the request with a bearer key from the env/deps without calling the network", async () => {
		let seen: { url: string; init: RequestInit } | undefined;
		const fakeFetch = (async (url: string, init: RequestInit) => {
			seen = { url, init };
			return new Response(JSON.stringify({ choices: [{ message: { content: GOOD }, finish_reason: "stop" }], usage: { prompt_tokens: 1 } }));
		}) as unknown as typeof fetch;
		const res = await runAdvisor("anthropic/x", msgs, openRouterComplete({ model: "anthropic/x" }, { apiKey: "k-test", fetch: fakeFetch }));
		expect(res.ok).toBe(true);
		expect(seen!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer k-test");
		expect(JSON.parse(String(seen!.init.body)).messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
	});
	it("fails cleanly without a key", async () => {
		const prev = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		const r = await openRouterComplete({ model: "anthropic/x" }, { fetch: (() => { throw new Error("no network"); }) as any })(msgs);
		if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
		expect(r).toMatchObject({ stopReason: "error", errorMessage: "OPENROUTER_API_KEY is not set" });
	});
});

describe("runAdvisor", () => {
	it("retries once on invalid JSON, with the bad reply in the conversation", async () => {
		const seen: ChatMessage[][] = [];
		const replies = ["not json", GOOD];
		const r = await runAdvisor("m", [{ role: "user", content: "P" }], async (m) => {
			seen.push([...m]);
			return { text: replies.shift()!, stopReason: "stop" };
		});
		expect(r).toMatchObject({ ok: true, attempts: 2 });
		expect(seen[1]!.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
	});
});

describe("pi layer", () => {
	it("maps the cacheable system message to pi's systemPrompt (pi-ai adds cache_control for openrouter/anthropic)", () => {
		const c = toPiContext([
			{ role: "system", content: "PREFIX", cache: true },
			{ role: "user", content: "WORK" },
		]);
		expect(c.systemPrompt).toBe("PREFIX");
		expect(c.messages).toHaveLength(1);
		expect(c.messages[0]!.content).toEqual([{ type: "text", text: "WORK" }]);
		expect(DEFAULT_CONFIG.advisor.cache).toBe("short");
	});
	it("mentions masking/stubs only when compaction is enabled", () => {
		expect(systemSnippet(false)).not.toContain("stub");
		expect(systemSnippet(true)).toContain("baton_recall");
	});
	it("baton.example.json equals the defaults", () => {
		expect(JSON.parse(readFileSync(new URL("../baton.example.json", import.meta.url), "utf8"))).toEqual(DEFAULT_CONFIG);
	});
});

describe("baton-pack CLI args", () => {
	it("parses options and the task", () => {
		const a = parseArgs(["--kind", "help", "--claim", "x", "--", "fix", "it"]);
		expect(a).toMatchObject({ kind: "help", claims: ["x"], task: "fix it" });
		expect(() => parseArgs([])).toThrow(/task/);
	});
});

describe("core is pi-independent", () => {
	it("no file under src/core or src/cli imports pi", async () => {
		const { readdirSync } = await import("node:fs");
		const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
		const root = new URL("../src/", import.meta.url).pathname;
		for (const f of [...walk(join(root, "core")), ...walk(join(root, "cli"))]) expect(readFileSync(f, "utf8"), f).not.toMatch(/@earendil-works|\.\.\/pi\//);
	});
});
