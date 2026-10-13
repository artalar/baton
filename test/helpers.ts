import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function gitRepo(files: Record<string, string> = { "src/model.ts": "export const model = 1;\n" }): string {
	const dir = mkdtempSync(join(tmpdir(), "baton-git-"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
	git("init", "-q");
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	writeFileSync(join(dir, ".gitignore"), "ignored/\n");
	git("add", ".");
	git("commit", "-qm", "init");
	return dir;
}
