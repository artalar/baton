import { describe, expect, it } from "vitest";
import { guardHelperCall } from "../src/guard.ts";

const files: Record<string, string> = {
	"src/model.ts": "export const model = 1;\n",
	"src/game.test.ts": "it('a', () => {});\nit('b', () => {});\n",
	"package.json": '{"dependencies":{"react":"^19.1.0"}}',
};
const context = { fileExists: (path: string) => path in files, readFile: (path: string) => files[path] };
const call = (name: string, args: Record<string, unknown>) => ({ id: "c", name, args });

describe("helper guardrails", () => {
	it("allows reads, checks, new files and targeted edits", () => {
		expect(guardHelperCall(call("read", { path: "src/model.ts" }), context)).toBeUndefined();
		expect(guardHelperCall(call("bash", { command: "npm test && npm run build" }), context)).toBeUndefined();
		expect(guardHelperCall(call("write", { path: "src/view.ts", content: "export {}" }), context)).toBeUndefined();
		expect(guardHelperCall(call("edit", { path: "src/model.ts", oldText: "1", newText: "2" }), context)).toBeUndefined();
	});

	it("blocks rewriting the lead's files and weakening tests", () => {
		expect(guardHelperCall(call("write", { path: "src/model.ts", content: "rewritten" }), context)).toMatch(/overwrites the existing file src\/model\.ts/);
		expect(guardHelperCall(call("edit", { path: "src/game.test.ts", oldText: "it('a', () => {});\nit('b', () => {});", newText: "it('a', () => {});" }), context)).toBe("removes test cases");
		expect(guardHelperCall(call("edit", { path: "src/game.test.ts", oldText: "it('a'", newText: "it.skip('a'" }), context)).toMatch(/skips tests/);
		expect(guardHelperCall(call("bash", { command: "rm src/game.test.ts" }), context)).toBe("deletes test files");
		expect(guardHelperCall(call("bash", { command: "npx vitest run --passWithNoTests" }), context)).toMatch(/passWithNoTests/);
	});

	it("blocks git history changes, version downgrades, casts and lead-only tools", () => {
		expect(guardHelperCall(call("bash", { command: "git stash && npm test" }), context)).toMatch(/git stash/);
		expect(guardHelperCall(call("bash", { command: "git status && git diff" }), context)).toBeUndefined();
		expect(guardHelperCall(call("edit", { path: "package.json", oldText: '"^19.1.0"', newText: '"^18.2.0"' }), context)).toMatch(/downgrades react/);
		expect(guardHelperCall(call("edit", { path: "src/model.ts", oldText: "1", newText: "x as unknown as number" }), context)).toMatch(/as unknown as/);
		expect(guardHelperCall(call("baton_rollback", {}), context)).toMatch(/lead model only/);
	});
});
