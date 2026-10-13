import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Journal {
	readonly dir: string;
	log(kind: string, data?: Record<string, unknown>): void;
	writeSummary(summary: Record<string, unknown>): void;
}

/** Best effort: a journal failure never breaks the session. */
export function openJournal(rootDir: string, sessionId: string | undefined): Journal {
	const dir = sessionId ? join(rootDir, "sessions", sessionId.replace(/[^\w.-]/g, "_")) : rootDir;
	const ensureDir = () => {
		mkdirSync(dir, { recursive: true });
		const gitignore = join(rootDir, ".gitignore");
		if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n");
	};
	return {
		dir,
		log(kind, data = {}) {
			try {
				ensureDir();
				appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), kind, ...data })}\n`);
			} catch {
				/* best effort */
			}
		},
		writeSummary(summary) {
			try {
				ensureDir();
				writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
			} catch {
				/* best effort */
			}
		},
	};
}
