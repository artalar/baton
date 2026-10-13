import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReviewPack } from "../src/core/pack/index.ts";
import { ARTIFACT, diffSnaps, snapshot } from "../src/pi/fsguard.ts";
import { advisorKeepaliveWorthIt } from "../src/pi/config.ts";

const base = { task: "T", userPrompts: [], agentsMd: "AGENTS", skills: [{ name: "reatom", path: "p", body: "SKILL" }] };

describe("0.11 advisor cache: one stable prefix for plan / review / help", () => {
	it("system prefix is byte-identical across kinds; the kind role is the first user section", () => {
		const plan = buildReviewPack({ ...base, kind: "plan" as const, repoMap: "src/a.ts" });
		const review = buildReviewPack({ ...base, kind: "review" as const, diff: "+x" });
		const help = buildReviewPack({ ...base, kind: "help" as const, question: "why?" });
		expect(review.messages[0]!.content).toBe(plan.messages[0]!.content);
		expect(help.messages[0]!.content).toBe(plan.messages[0]!.content);
		expect(review.messages[1]!.content.indexOf("## CALL ROLE")).toBeLessThan(review.messages[1]!.content.indexOf("## TASK"));
		expect(review.messages[1]!.content).toContain("senior reviewer");
	});
	it("a frozen prefix is reused verbatim even if the skill selection would differ", () => {
		const first = buildReviewPack({ ...base, kind: "plan" as const });
		const later = buildReviewPack({ ...base, kind: "review" as const, skills: [{ name: "other", path: "q", body: "OTHER" }], diff: "+y" }, { frozenSystem: first.messages[0]!.content });
		expect(later.messages[0]!.content).toBe(first.messages[0]!.content);
		expect(later.messages[1]!.content).not.toContain("OTHER");
	});
	it("keepalive pays off while pings·0.1 < p·1.15", () => {
		expect(advisorKeepaliveWorthIt(5, 1)).toBe(true);
		expect(advisorKeepaliveWorthIt(11, 1)).toBe(true);
		expect(advisorKeepaliveWorthIt(12, 1)).toBe(false);
		expect(advisorKeepaliveWorthIt(5, 0.4)).toBe(false);
	});
});

describe("0.11 fs guard ignores build/test artefacts", () => {
	it("ARTIFACT matches dist, coverage, .vite, tsbuildinfo, caches; not sources", () => {
		for (const p of ["dist/index.js", "coverage/lcov.info", "node_modules/.vite/x", ".vite/deps", "tsconfig.tsbuildinfo", "a/.cache/x", ".vitest/r.json", "vite.config.ts.timestamp-123.mjs"]) expect(ARTIFACT.test(p), p).toBe(true);
		for (const p of ["src/dist.ts", "src/game/model.ts", "vite.config.ts", "package.json"]) expect(ARTIFACT.test(p), p).toBe(false);
	});
	it("a test/build run that writes dist/, coverage/, node_modules/.vite is no change; a source edit is", () => {
		const d = mkdtempSync(join(tmpdir(), "fsg-"));
		const g = (...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
		g("init", "-q");
		writeFileSync(join(d, "a.ts"), "1");
		g("add", "-A");
		g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "b");
		mkdirSync(join(d, "node_modules"));
		writeFileSync(join(d, "node_modules", ".package-lock.json"), "{}");
		const pre = snapshot(d);
		mkdirSync(join(d, "dist"));
		writeFileSync(join(d, "dist", "x.js"), "x");
		mkdirSync(join(d, "coverage"));
		writeFileSync(join(d, "coverage", "c.json"), "x");
		mkdirSync(join(d, "node_modules", ".vite"));
		writeFileSync(join(d, "tsconfig.tsbuildinfo"), "x");
		const mid = snapshot(d);
		const dd = diffSnaps(pre, mid);
		expect(dd.changed).toEqual([]);
		expect(dd.nodeModulesChanged).toBe(false);
		writeFileSync(join(d, "a.ts"), "2");
		expect(diffSnaps(mid, snapshot(d)).changed).toEqual(["a.ts"]);
	});
});
