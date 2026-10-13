export interface ToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

export interface ToolOutput {
	id: string;
	isError: boolean;
	text: string;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "glob"]);
const READ_ONLY_COMMAND =
	/^(ls|cat|head|tail|wc|tree|find|grep|rg|fd|file|stat|pwd|echo|nl|sort|uniq|cut|awk|jq|du|sed\s+-n|git\s+(-C\s+\S+\s+)?(status|log|diff|show|ls-files|branch|rev-parse|blame)|npm\s+(ls|view|info)|(node|npm|npx|pnpm|yarn|bun|git|tsc)\s+(-v|--version)|which)\b/;

export const commandOf = (call: Pick<ToolCall, "name" | "args">): string => (call.name === "bash" && typeof call.args.command === "string" ? call.args.command : "");

export const pathOf = (call: Pick<ToolCall, "args">): string => {
	const rawPath = call.args.path ?? call.args.file_path;
	return typeof rawPath === "string" ? rawPath.replace(/^\.\//, "") : "";
};

/**
 * The command segments that actually execute: heredoc bodies and quoted strings are removed so that file contents
 * written with `cat > f <<'EOF'` or `node -e '…'` are not mistaken for commands.
 */
export function executedSegments(command: string): string[] {
	let normalized = command.replace(/\\\n/g, " ");
	normalized = normalized.replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, (_match, _quote, _tag, restOfLine: string) => ` ${restOfLine}`);
	normalized = normalized.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
	return normalized
		.split(/&&|\|\||;|\||\n|\(|\)/)
		.map((segment) =>
			segment
				.trim()
				.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")
				.replace(/^(?:timeout\s+(?:-\S+\s+)*\S+\s+|time\s+|env\s+)/, "")
				.trim(),
		)
		.filter(Boolean);
}

export function isReadOnly(call: Pick<ToolCall, "name" | "args">): boolean {
	if (READ_TOOLS.has(call.name)) return true;
	const command = commandOf(call);
	if (!command.trim()) return false;
	const withoutHarmlessRedirects = command.replace(/2>&1|2>\/dev\/null|>\s*\/dev\/null/g, "");
	if (/(^|[^2&])>|>>|\btee\b|\$\(|`/.test(withoutHarmlessRedirects)) return false;
	const segments = command
		.split(/&&|\|\||;|\|/)
		.map((segment) => segment.trim().replace(/^cd\s+\S+\s*$/, "pwd"))
		.filter(Boolean);
	return segments.length > 0 && segments.every((segment) => READ_ONLY_COMMAND.test(segment));
}

const RUNNER = "(?:(?:npx|bunx|pnpm\\s+(?:exec|dlx)|yarn(?:\\s+exec)?)\\s+(?:-\\S+\\s+)*)?";
const SCRIPT = (names: string) => `^(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:-s\\s+)?(?:${names})\\b`;
const TEST_START = new RegExp(`^${RUNNER}(?:vitest|jest|mocha|playwright\\s+test)\\b|^node\\s+--test\\b|${SCRIPT("test")}`);
const TYPECHECK_START = new RegExp(`^${RUNNER}(?:tsc|vue-tsc)\\b|${SCRIPT("typecheck|check")}`);
const BUILD_START = new RegExp(`^${RUNNER}vite\\s+build\\b|${SCRIPT("build")}`);
const LINT_START = new RegExp(`^${RUNNER}(?:eslint|biome)\\b|${SCRIPT("lint")}`);

export type CheckKind = "test" | "typecheck" | "build" | "lint";

export function checkKinds(call: Pick<ToolCall, "name" | "args">): CheckKind[] {
	const kinds = new Set<CheckKind>();
	for (const segment of executedSegments(commandOf(call))) {
		if (/\s--version\b|\s-v$/.test(segment)) continue;
		if (TEST_START.test(segment)) kinds.add("test");
		else if (TYPECHECK_START.test(segment)) kinds.add("typecheck");
		else if (BUILD_START.test(segment)) kinds.add("build");
		else if (LINT_START.test(segment)) kinds.add("lint");
	}
	return [...kinds];
}

export function bashWriteTargets(call: Pick<ToolCall, "name" | "args">): string[] {
	const command = commandOf(call);
	if (!command) return [];
	const targets: string[] = [];
	for (const segment of executedSegments(command)) {
		for (const match of segment.matchAll(/(?:^|[^0-9&>])>{1,2}\s*([^\s&>]+)/g)) if (!/^\/dev\/(null|std)/.test(match[1]!)) targets.push(match[1]!);
		const teeTarget = /^tee\s+(?:-a\s+)?(\S+)/.exec(segment)?.[1];
		if (teeTarget) targets.push(teeTarget);
	}
	return targets.map((target) => target.replace(/^\.\//, ""));
}

export function editTargets(call: Pick<ToolCall, "name" | "args">): string[] {
	if (call.name === "edit" || call.name === "write") return [pathOf(call)].filter(Boolean);
	return bashWriteTargets(call);
}

export const isEdit = (call: Pick<ToolCall, "name" | "args">) => editTargets(call).length > 0;

const ERROR_LINE = /\berror\b|\bfail(?:ed|ure|s)?\b|✗|×|\bexception\b|\bTS\d{4}\b|\bERR!|\bpanic\b/i;
const BENIGN_ERROR_LINE = /\b0 (?:errors?|failed|failures)\b|\bno errors?\b|\bfailed: 0\b/i;

export function errorLines(text: string, limit = 3): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && ERROR_LINE.test(line) && !BENIGN_ERROR_LINE.test(line))
		.slice(0, limit)
		.map((line) => line.slice(0, 200));
}

export type CallStatus = "ok" | "error" | "suspect";

export interface CallOutcome {
	status: CallStatus;
	detail: string;
}

/**
 * The outcome the harness reports for a call. A tool error is an error. A check command whose exit status is 0 but
 * whose output reports errors is "suspect": with a pipe, the status is only the last segment's (`npm test | tail`).
 */
export function callOutcome(call: Pick<ToolCall, "name" | "args">, output: Pick<ToolOutput, "isError" | "text"> | undefined): CallOutcome {
	if (!output) return { status: "error", detail: "no result (blocked or interrupted)" };
	if (output.isError) return { status: "error", detail: errorLines(output.text)[0] ?? lastLine(output.text) };
	const command = commandOf(call);
	if (!command || isReadOnly(call)) return { status: "ok", detail: "" };
	const reportedErrors = errorLines(output.text);
	if (!reportedErrors.length) return { status: "ok", detail: "" };
	const isPiped = /\|(?!\|)/.test(command.replace(/\|\|/g, ""));
	const looksLikeCheck = checkKinds(call).length > 0;
	if (!looksLikeCheck && !isPiped) return { status: "ok", detail: "" };
	const reason = isPiped ? "exit 0 comes from the last command of a pipe" : "exit 0";
	return { status: "suspect", detail: `${reason}, but the output reports errors: ${reportedErrors[0]}` };
}

const lastLine = (text: string) =>
	text
		.trim()
		.split("\n")
		.filter(Boolean)
		.slice(-1)[0]
		?.slice(0, 200) ?? "";

export function describeCall(call: Pick<ToolCall, "name" | "args">, maxChars = 200): string {
	const command = commandOf(call);
	if (command) return `bash \`${oneLine(command, maxChars)}\``;
	const path = pathOf(call);
	if (path) return `${call.name} ${path}`;
	const pattern = call.args.pattern ?? call.args.query;
	if (typeof pattern === "string") return `${call.name} ${oneLine(pattern, maxChars)}`;
	return `${call.name} ${oneLine(JSON.stringify(call.args), maxChars)}`;
}

export const oneLine = (text: string, maxChars = 200) => {
	const flattened = text.replace(/\s+/g, " ").trim();
	return flattened.length > maxChars ? `${flattened.slice(0, maxChars - 1)}…` : flattened;
};

export const callSignature = (call: Pick<ToolCall, "name" | "args">) => `${call.name} ${JSON.stringify(call.args)}`;

export const TEST_FILE = /(^|\/)[^/]*\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//;
