import { describe, expect, it } from "vitest";
import { callOutcome, checkKinds, editTargets, executedSegments, isReadOnly } from "../src/calls.ts";

const bash = (command: string) => ({ name: "bash", args: { command } });

describe("command parsing", () => {
	it("ignores heredoc bodies and quoted strings", () => {
		const command = `cat > package.json <<'EOF'\n{"scripts":{"build":"tsc && vite build"}}\nEOF\nnode -e 'run("npm test")'`;
		expect(executedSegments(command)).toEqual(["cat > package.json", "node -e ''"]);
		expect(checkKinds(bash(command))).toEqual([]);
	});

	it("detects checks in executed segments", () => {
		expect(checkKinds(bash("npx tsc --noEmit && npm run build 2>&1 | tail -5"))).toEqual(["typecheck", "build"]);
		expect(checkKinds(bash("CI=1 npx vitest run"))).toEqual(["test"]);
		expect(checkKinds(bash("npx tsc --version"))).toEqual([]);
	});

	it("classifies reads and writes", () => {
		expect(isReadOnly(bash("cat src/a.ts | head -20"))).toBe(true);
		expect(isReadOnly(bash("echo x > a.txt"))).toBe(false);
		expect(isReadOnly({ name: "grep", args: { pattern: "x" } })).toBe(true);
		expect(editTargets(bash("cat > src/a.ts <<'EOF'\nx\nEOF"))).toEqual(["src/a.ts"]);
		expect(editTargets({ name: "edit", args: { path: "./src/b.ts" } })).toEqual(["src/b.ts"]);
	});
});

describe("call outcome", () => {
	it("reports a piped check with exit 0 and failing output as unreliable", () => {
		const outcome = callOutcome(bash("npm test 2>&1 | tail -20"), { isError: false, text: " FAIL src/game.test.ts > drops piece\nTests 1 failed | 4 passed" });
		expect(outcome.status).toBe("suspect");
		expect(outcome.detail).toMatch(/last command of a pipe/);
		expect(outcome.detail).toMatch(/FAIL src\/game\.test\.ts/);
	});

	it("keeps clean runs, read outputs and tool errors as they are", () => {
		expect(callOutcome(bash("npm test 2>&1 | tail -5"), { isError: false, text: "Tests 5 passed\n0 failed" }).status).toBe("ok");
		expect(callOutcome(bash("grep -rn error src | head"), { isError: false, text: "src/a.ts:1: throw new Error()" }).status).toBe("ok");
		expect(callOutcome(bash("npx tsc --noEmit"), { isError: true, text: "src/a.ts(1,1): error TS2322: bad" })).toEqual({ status: "error", detail: "src/a.ts(1,1): error TS2322: bad" });
		expect(callOutcome(bash("ls"), undefined).status).toBe("error");
	});
});
