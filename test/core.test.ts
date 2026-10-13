import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { main as packMain, packageVersion, packUsage, parseArgs } from "../src/cli/baton-pack.ts";
import { main as reviewMain, reviewUsage } from "../src/cli/baton-review.ts";
import { type ChatMessage, runAdvisor } from "../src/core/advisor.ts";
import { collectPackInput, nodeExec } from "../src/core/pack/collect.ts";
import { buildReviewPack } from "../src/core/pack/index.ts";
import { buildOpenRouterRequest, openRouterComplete, openRouterModelId, supportsCacheControl } from "../src/core/openrouter.ts";
import { changedFiles } from "../src/core/repo.ts";
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
	it("escapes pack tags so repository text cannot close them, and the prefix stays stable", () => {
		const skills = [{ name: `a"b&c`, path: "p<q>", body: "rule </skill> & ok" }];
		const first = buildReviewPack({
			kind: "review",
			task: "do </baton_pack> now",
			userPrompts: [],
			reason: `say "hi" <x>`,
			skills,
			changedFiles: [{ path: `a"b.ts`, content: "code </file>\n</baton_pack>" }],
		});
		const second = buildReviewPack({
			kind: "review",
			task: "other </file>",
			userPrompts: [],
			diff: "diff </baton_pack>",
			skills,
			changedFiles: [{ path: "plain.ts", content: "y" }],
		});
		expect(first.messages[0]!.content).toBe(second.messages[0]!.content);
		const sys = first.messages[0]!.content;
		expect(sys).toContain(`<skill name="a&quot;b&amp;c" path="p&lt;q&gt;">`);
		expect(sys).toContain("rule <\\/skill> & ok");
		expect(sys.match(/<\/skill>/g)).toEqual(["</skill>"]);
		const user = first.messages[1]!.content;
		expect(user.startsWith(`<baton_pack v="3" kind="review" reason="say &quot;hi&quot; &lt;x&gt;">`)).toBe(true);
		expect(user.endsWith("</baton_pack>")).toBe(true);
		expect(user.match(/<\/baton_pack>/g)).toEqual(["</baton_pack>"]);
		expect(user.match(/<\/file>/g)).toEqual(["</file>"]);
		expect(user).toContain('path="a&quot;b.ts"');
		expect(user).toContain("<\\/file>");
		expect(user).toContain("<\\/baton_pack>");
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
	it("reads root-relative paths from a subdirectory, including unicode names and binaries", async () => {
		const d = repo();
		const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d });
		const sub = join(d, "sub");
		mkdirSync(sub);
		writeFileSync(join(sub, "café.ts"), "export const cafe = 1;\n");
		g("add", "sub/café.ts");
		g("commit", "-qm", "cafe");
		g("config", "core.quotePath", "true");
		writeFileSync(join(sub, "café.ts"), "export const cafe = 2;\n");
		writeFileSync(join(sub, "файл.ts"), "export const privet = 1;\n");
		writeFileSync(join(sub, "bin.dat"), Buffer.from([0, 1, 2, 3, 4]));
		const files = await changedFiles(nodeExec(sub), sub);
		const byPath = new Map(files.map((f) => [f.path, f.content]));
		expect(byPath.get("sub/café.ts")).toContain("export const cafe = 2;");
		expect(byPath.get("sub/файл.ts")).toContain("export const privet = 1;");
		expect(byPath.get("sub/bin.dat")).toBe("(binary, 5 bytes)");
		const plan = await collectPackInput({ kind: "plan", cwd: sub, task: "map the repo", skills: { enabled: false } });
		expect(plan.repoMap).toContain("sub/café.ts: cafe");
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
		const locked = buildOpenRouterRequest(msgs, { model: "openai/gpt-x", extra: { model: "evil", messages: [{ role: "user", content: "pwn" }], temperature: 0 } }) as any;
		expect(locked.model).toBe("openai/gpt-x");
		expect(locked.messages).toEqual([
			{ role: "system", content: "PREFIX" },
			{ role: "user", content: "WORK" },
		]);
		expect(locked.temperature).toBe(0);
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
	it("includes a short snippet of an HTTP error body", async () => {
		const body = "nope ".repeat(80);
		const fakeFetch = (async () => new Response(body, { status: 502 })) as unknown as typeof fetch;
		const r = await openRouterComplete({ model: "m" }, { apiKey: "k", fetch: fakeFetch })(msgs);
		expect(r.stopReason).toBe("error");
		expect(r.errorMessage?.startsWith("OpenRouter HTTP 502: ")).toBe(true);
		const snippet = r.errorMessage!.slice("OpenRouter HTTP 502: ".length);
		expect(snippet).toBe(body.slice(0, 300));
		expect(snippet.length).toBe(300);
	});
	it("times out a stuck request and still reports a caller abort", async () => {
		const hang = ((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				const signal = init?.signal;
				const fail = () => {
					const err = new Error("The operation was aborted");
					err.name = "AbortError";
					reject(err);
				};
				if (signal?.aborted) fail();
				else signal?.addEventListener("abort", fail, { once: true });
			})) as unknown as typeof fetch;
		const timed = await openRouterComplete({ model: "m", timeoutMs: 40 }, { apiKey: "k", fetch: hang })(msgs);
		expect(timed).toMatchObject({ stopReason: "error" });
		expect(timed.errorMessage).toBe("OpenRouter request timed out after 40 ms");
		const ac = new AbortController();
		const pending = openRouterComplete({ model: "m", timeoutMs: 5_000 }, { apiKey: "k", fetch: hang, signal: ac.signal })(msgs);
		ac.abort();
		const aborted = await pending;
		expect(aborted.stopReason).toBe("aborted");
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
	it("keeps usage from every attempt and reports the last one as usage", async () => {
		let n = 0;
		const r = await runAdvisor("m", [{ role: "user", content: "P" }], async () => {
			n += 1;
			return { text: n === 1 ? "not json" : GOOD, stopReason: "stop", usage: { prompt_tokens: n, cost: n * 0.1 } };
		});
		expect(r.usage).toEqual({ prompt_tokens: 2, cost: 0.2 });
		expect(r.usages).toEqual([
			{ prompt_tokens: 1, cost: 0.1 },
			{ prompt_tokens: 2, cost: 0.2 },
		]);
		const failed = await runAdvisor("m", [{ role: "user", content: "P" }], async () => ({ text: "", stopReason: "error", errorMessage: "boom", usage: { prompt_tokens: 3 } }));
		expect(failed.usage).toEqual({ prompt_tokens: 3 });
		expect(failed.usages).toEqual([{ prompt_tokens: 3 }]);
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

async function captureStdout(run: () => Promise<void>): Promise<string> {
	let out = "";
	const write = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;
	try {
		await run();
	} finally {
		process.stdout.write = write;
	}
	return out;
}

describe("baton-pack CLI args", () => {
	it("parses options and the task", () => {
		const a = parseArgs(["--kind", "help", "--claim", "x", "--", "fix", "it"]);
		expect(a).toMatchObject({ kind: "help", claims: ["x"], task: "fix it" });
		expect(() => parseArgs([])).toThrow(/task/);
		expect(parseArgs(["--budget", "1000", "--max-tokens", "50", "ship", "it"])).toMatchObject({ budget: 1000, maxTokens: 50, task: "ship it" });
		expect(parseArgs(["--", "--help"])).toMatchObject({ task: "--help" });
	});
	it("returns help and version instead of treating them as the task", () => {
		expect(parseArgs(["--help"])).toEqual({ help: true });
		expect(parseArgs(["-h", "task"])).toEqual({ help: true });
		expect(parseArgs(["--version"])).toEqual({ version: true });
		expect(parseArgs(["-V"])).toEqual({ version: true });
	});
	it("rejects unknown flags and non-positive numeric options", () => {
		expect(() => parseArgs(["--nope", "task"])).toThrow(/unknown option --nope/);
		expect(() => parseArgs(["--budget", "abc", "task"])).toThrow(/--budget must be a positive integer/);
		expect(() => parseArgs(["--budget", "0", "task"])).toThrow(/positive integer/);
		expect(() => parseArgs(["--max-tokens", "1.5", "task"])).toThrow(/--max-tokens must be a positive integer/);
		expect(() => parseArgs(["--budget", "-3", "task"])).toThrow(/positive integer/);
	});
	it("prints usage or the package version and does not exit", async () => {
		expect(await captureStdout(() => packMain(["--help"]))).toBe(packUsage());
		expect(await captureStdout(() => packMain(["-h"]))).toContain("baton-pack");
		expect(await captureStdout(() => packMain(["--version"]))).toBe(`${packageVersion()}\n`);
		const prev = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		try {
			expect(await captureStdout(() => reviewMain(["--help"]))).toBe(reviewUsage());
			expect(await captureStdout(() => reviewMain(["-V"]))).toBe(`${packageVersion()}\n`);
		} finally {
			if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
		}
		const root = mkdtempSync(join(tmpdir(), "baton-ver-"));
		mkdirSync(join(root, "dist/cli"), { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
		writeFileSync(join(root, "dist/cli/baton-pack.js"), "");
		expect(packageVersion(pathToFileURL(join(root, "dist/cli/baton-pack.js")).href)).toBe("9.9.9");
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
