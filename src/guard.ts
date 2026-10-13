import { commandOf, executedSegments, pathOf, TEST_FILE, type ToolCall } from "./calls.ts";

export interface GuardContext {
	fileExists: (path: string) => boolean;
	readFile: (path: string) => string | undefined;
}

const TEST_CASE = /\b(?:it|test)(?:\.each\([^)]*\))?\s*\(/g;
const SKIPPED_TEST = /\b(?:it|test|describe)\.(?:skip|todo)\b|\bx(?:it|describe|test)\s*\(|\.only\s*\(/g;
const UNSAFE_CAST = /\bas unknown as\b/g;
const HISTORY_GIT = /^git\s+(?:-C\s+\S+\s+)?(commit|push|reset|checkout|restore|clean|stash|rebase|merge|switch|cherry-pick|revert|am|apply)\b/;
const TEST_PATH_IN_COMMAND = /\.(test|spec)\.|__tests__|\btests?\//;
const BATON_TOOLS = new Set(["baton_rollback"]);

const countMatches = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

function packageVersions(text: string): Map<string, number[]> {
	const versions = new Map<string, number[]>();
	for (const [, name, version] of text.matchAll(/"([@\w./-]+)"\s*:\s*"[~^>=]*(\d+(?:\.\d+){0,2})[^"]*"/g)) versions.set(name!, version!.split(".").map(Number));
	return versions;
}

function isLowerVersion(candidate: number[], current: number[]): boolean {
	for (let index = 0; index < 3; index++) {
		const candidatePart = candidate[index] ?? 0;
		const currentPart = current[index] ?? 0;
		if (candidatePart !== currentPart) return candidatePart < currentPart;
	}
	return false;
}

/** The file before and after the call; the edited snippets alone when the file cannot be read. */
function contentChange(call: ToolCall, context: GuardContext): { before: string; after: string } {
	const current = context.readFile(pathOf(call));
	if (call.name === "write") return { before: current ?? "", after: String(call.args.content ?? "") };
	const edits = (Array.isArray(call.args.edits) ? call.args.edits : [{ oldText: call.args.oldText, newText: call.args.newText }]) as { oldText?: unknown; newText?: unknown }[];
	const replacements = edits.map((edit) => ({ oldText: String(edit.oldText ?? ""), newText: String(edit.newText ?? "") }));
	if (current === undefined) return { before: replacements.map((edit) => edit.oldText).join("\n"), after: replacements.map((edit) => edit.newText).join("\n") };
	const after = replacements.reduce((content, edit) => (edit.oldText ? content.replace(edit.oldText, () => edit.newText) : content), current);
	return { before: current, after };
}

function guardCommand(command: string): string | undefined {
	if (/--passWithNoTests\b/.test(command)) return "runs tests with --passWithNoTests";
	for (const segment of executedSegments(command)) {
		if (/^(?:git\s+)?rm\b/.test(segment) && TEST_PATH_IN_COMMAND.test(segment)) return "deletes test files";
		const historyCommand = HISTORY_GIT.exec(segment)?.[1];
		if (historyCommand) return `runs \`git ${historyCommand}\`, which changes git history or discards work`;
		if (/^(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b.*\s@?[\w./-]+@\d/.test(segment)) return "pins package versions";
	}
	if (/\b(?:sed|perl)\b[^\n]*(?:\.skip|as unknown as)/.test(command)) return "edits tests or casts through sed";
	return undefined;
}

/**
 * Why the helper may not make this call during a speculative run, or undefined when it may.
 * The helper continues the lead's plan: it may read, run checks, create files and make targeted edits,
 * but it may not rewrite the lead's files, weaken tests, touch git history or change dependency versions.
 */
export function guardHelperCall(call: ToolCall, context: GuardContext): string | undefined {
	if (BATON_TOOLS.has(call.name)) return `${call.name} is for the lead model only`;
	const command = commandOf(call);
	if (command) return guardCommand(command);
	if (call.name !== "edit" && call.name !== "write") return undefined;
	const path = pathOf(call);
	if (call.name === "write" && path && context.fileExists(path)) return `overwrites the existing file ${path} (use targeted edits instead)`;
	const { before, after } = contentChange(call, context);
	if (countMatches(after, UNSAFE_CAST) > countMatches(before, UNSAFE_CAST)) return "adds an `as unknown as` cast";
	if (TEST_FILE.test(path)) {
		if (countMatches(after, SKIPPED_TEST) > countMatches(before, SKIPPED_TEST)) return "skips tests (.skip, .todo, x*, .only)";
		if (countMatches(after, TEST_CASE) < countMatches(before, TEST_CASE)) return "removes test cases";
	}
	if (/(^|\/)package\.json$/.test(path)) {
		const versionsBefore = packageVersions(before);
		for (const [name, version] of packageVersions(after)) {
			const previous = versionsBefore.get(name);
			if (previous && isLowerVersion(version, previous)) return `downgrades ${name} ${previous.join(".")} → ${version.join(".")}`;
		}
	}
	return undefined;
}
