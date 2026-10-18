import { createTwoFilesPatch } from "diff";
import { type FileChange, FILE_TOOLS, type RunCall, type UndoResult } from "./run.ts";

export const HARNESS = "[Baton]";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const OUTPUT_TAIL_CHARS = 2_000;

const LISTED_FILES_MAX = 30;

export const HELPER_LINE = "Helper:";

export function leadRequestsHelper(text: string): boolean {
	return text.split("\n").some((line) => line.trim().startsWith(HELPER_LINE));
}

export function leadSystemNote(scratchDir: string): string {
	return `

# Baton: speculative runs
You are the lead model in this session and the author of the work. A cheaper helper starts in this same session only after a line of your reply that begins with "${HELPER_LINE}". Without that line the next turn is yours. The helper sees everything you see and does only that request. It does not create product files.
The helper may read anything and run commands, but it may change only files you have changed with edit/write in this session, plus scratch files under ${scratchDir}/. Any other edit or write is blocked and ends its run. So every product file is yours: you create it and decide its design and API; after that the helper may make targeted edits to it.
Hand the helper mechanical steps you have already decided: reads you plan, running checks and fixing what they report, edits you have spelled out, scratch tests of behavior you describe. Put that request on its own line, e.g. "Helper: run the typecheck and the build, fix type errors" or "Helper: write a scratch test for … and run it".
You never see the helper's messages. After a run you get a message starting with "${HARNESS} Speculative run #N", built from facts only: its tool calls in order, read outputs verbatim, the status and output tail of other calls, the exact diff of the files it changed with edit/write, and the paths changed outside edit/write. Edit/write changes are already on disk. Review that diff as your own code before you build on it: keep what is right, fix what is not with your own edits, or undo it with baton_undo({run: N}) (add paths: [...] to undo only some files). Paths changed outside edit/write are not undone.
If the note already shows a successful typecheck or build of the current tree and you have not changed anything since, do not run it again. If the note says omitted or the diff was clipped, read that file. The harness runs no checks for you: run any other verification the task needs before your final answer.`;
}

export interface HelperScope {
	/** Files the lead changed with edit/write, relative to cwd. */
	leadFiles: string[];
	scratchDir: string;
}

function listFiles(paths: string[]): string {
	const listed = paths.slice(0, LISTED_FILES_MAX).join(", ");
	return paths.length > LISTED_FILES_MAX ? `${listed} and ${paths.length - LISTED_FILES_MAX} more` : listed;
}

export function helperInstruction(runNumber: number, { leadFiles, scratchDir }: HelperScope): string {
	const writable = leadFiles.length ? `only the files the lead has written (${listFiles(leadFiles)}) and files under ${scratchDir}/` : `no project file yet (the lead has written none), only files under ${scratchDir}/`;
	return [
		`${HARNESS} Speculative run #${runNumber}. You are now the helper model, not the lead. The "Baton" section of the system prompt describes the lead's side.`,
		`Do only the latest "${HELPER_LINE}" request in the lead's messages. If there is no such request, stop with no tool calls. You do not create product files and you do not change APIs. The lead reviews what you change and keeps, fixes or undoes it.`,
		`- You may read anything and run commands. You may change ${writable}; scratch tests, scripts and logs go there and nowhere else. Any other edit or write is blocked and ends your run: new files, designs and APIs are the lead's.`,
		"- Make targeted edits that keep the lead's names and interfaces. Never delete, skip or weaken tests.",
		"- Read with read/grep/find/ls. Change files only with edit/write: the lead reviews their diff. Paths you change through bash are listed and not undone. Do not pipe checks through tail/grep: the lead sees the output tail anyway. Batch independent calls in one turn.",
		`- Stop, with one short line and no tool call, when that request is done, when there is no such request, when the next step needs a decision, or when you are unsure. Stopping early is cheap; going the wrong way is expensive.`,
		"- Do not write a final answer for the user. The lead does not see your messages, only your tool calls and their results.",
	].join("\n");
}

export const HANDBACK_REASON = "Baton: the lead model takes over now. Reply with one short line and no tool call.";

export const blockedWriteReason = (path: string) => `Baton: blocked. Only the lead may create or change ${path}. Reply with one short line and no tool call.`;

export const blockedWriteStop = (toolName: string, path: string) => `it tried to ${toolName} ${path}, a file you have not changed with edit/write in this session (blocked, not run)`;

export const oneLine = (text: string, maxChars = 200) => {
	const flattened = text.replace(/\s+/g, " ").trim();
	return flattened.length > maxChars ? `${flattened.slice(0, maxChars - 1)}…` : flattened;
};

export function describeCall(call: Pick<RunCall, "name" | "args">, maxChars = 200): string {
	const { command, path, pattern } = call.args;
	if (call.name === "bash" && typeof command === "string") return `bash \`${oneLine(command, maxChars)}\``;
	const target = [pattern, path].filter((value): value is string => typeof value === "string").map((value) => (value === pattern ? JSON.stringify(value) : value));
	if (target.length) return `${call.name} ${oneLine(target.join(" in "), maxChars)}`;
	return `${call.name} ${oneLine(JSON.stringify(call.args), maxChars)}`;
}

const isBinary = (content: Buffer | undefined) => !!content?.includes(0);

const tail = (text: string, maxChars: number) => (text.length > maxChars ? `[…]${text.slice(-maxChars)}` : text);

function patchOf(change: FileChange): { patch: string; added: number; removed: number } {
	if (isBinary(change.before) || isBinary(change.after)) return { patch: `Binary file ${change.path} changed`, added: 0, removed: 0 };
	const before = change.before?.toString("utf8") ?? "";
	const after = change.after?.toString("utf8") ?? "";
	const patch = createTwoFilesPatch(change.before ? `a/${change.path}` : "/dev/null", change.after ? `b/${change.path}` : "/dev/null", before, after, "", "", { context: 3 })
		.split("\n")
		.slice(1)
		.join("\n")
		.trimEnd();
	const lines = patch.split("\n");
	return { patch, added: lines.filter((line) => /^\+(?!\+\+)/.test(line)).length, removed: lines.filter((line) => /^-(?!--)/.test(line)).length };
}

function callLine(call: RunCall, index: number, outputShown: boolean): string {
	const status = call.blocked ? "blocked, not run" : call.output === undefined ? "no result" : call.isError ? "error" : "ok";
	const line = `${index + 1}. ${describeCall(call)} → ${status}`;
	const output = call.output?.trim();
	if (!output || call.blocked) return line;
	if (READ_TOOLS.has(call.name) && !call.isError) return outputShown ? `${line} (output below)` : line;
	if (FILE_TOOLS.has(call.name) && !call.isError) return line;
	return `${line}\n${tail(output, OUTPUT_TAIL_CHARS).replace(/^/gm, "   ")}`;
}

export interface RunNoteInput {
	runNumber: number;
	helperModel: string;
	stopReason: string;
	turns: number;
	calls: RunCall[];
	changes: FileChange[];
	outsidePaths?: string[];
	noteChars: number;
}

export function renderRunNote({ runNumber, helperModel, stopReason, turns, calls, changes, outsidePaths = [], noteChars }: RunNoteInput): string {
	const helperName = helperModel.split("/").pop();
	const header = `${HARNESS} Speculative run #${runNumber} by the helper model (${helperName}), not by you. Its file changes are already on disk.\nIt stopped because ${stopReason}: ${turns} turn(s), ${calls.length} tool call(s).`;
	const footer = changes.length
		? "Continue from here: keep the run, fix it, or undo it."
		: outsidePaths.length
			? "Continue the task."
			: "This run changed no files. Continue the task.";

	const seenReads = new Set<string>();
	const reads = calls.flatMap((call) => {
		if (!READ_TOOLS.has(call.name) || call.isError || !call.output?.trim()) return [];
		const key = `${describeCall(call, 10_000)}\u0000${call.output}`;
		if (seenReads.has(key)) return [];
		seenReads.add(key);
		return [{ call, title: `--- ${describeCall(call)} ---` }];
	});

	const patches = changes.map((change) => ({ change, ...patchOf(change) }));
	const fileLines = patches.map(({ change, added, removed }) => {
		const kind = change.before === undefined ? "created" : change.after === undefined ? "deleted" : "modified";
		return `- ${kind} ${change.path} (+${added} −${removed})`;
	});
	const filesSection = changes.length
		? `Files changed with edit/write (undo: baton_undo({run: ${runNumber}}) or baton_undo({run: ${runNumber}, paths: [...]})):\n${fileLines.join("\n")}`
		: "Files changed with edit/write: none.";
	const outsideSection = outsidePaths.length ? `Paths changed outside edit/write (not undone):\n${outsidePaths.map((path) => `- ${path}`).join("\n")}` : "";

	const draftCalls = (shown: Set<RunCall>) => `Tool calls:\n${calls.map((call, index) => callLine(call, index, shown.has(call))).join("\n") || "(none)"}`;
	const fixedChars = header.length + draftCalls(new Set(reads.map((read) => read.call))).length + filesSection.length + outsideSection.length + footer.length + 40;
	let remaining = Math.max(noteChars - fixedChars, 0);

	const fullDiff = patches.map((entry) => entry.patch).join("\n");
	const perFileLimit = Math.max(Math.floor(remaining / Math.max(patches.length, 1)), 200);
	const diff = fullDiff.length <= remaining ? fullDiff : patches.map((entry) => (entry.patch.length > perFileLimit ? `${entry.patch.slice(0, perFileLimit)}\n[diff clipped — read ${entry.change.path}]` : entry.patch)).join("\n");
	remaining -= diff.length;

	const shownReads = new Set<RunCall>();
	const readSections = reads.map(({ call, title }) => {
		const section = `${title}\n${call.output}`;
		if (section.length > remaining) return `${title}\n[omitted — read it yourself]`;
		remaining -= section.length;
		shownReads.add(call);
		return section;
	});

	return [
		header,
		draftCalls(shownReads),
		filesSection,
		...(outsideSection ? [outsideSection] : []),
		...(diff ? [`Diff (before the run → now):\n${diff}`] : []),
		...(readSections.length ? [`Read outputs (verbatim):\n${readSections.join("\n")}`] : []),
		footer,
	].join("\n\n");
}

export function renderUndoResult(runNumber: number, result: UndoResult): string {
	const parts = [
		result.restored.length && `restored ${result.restored.join(", ")}`,
		result.deleted.length && `deleted ${result.deleted.join(", ")} (created by the run)`,
		result.changedLater.length && `left ${result.changedLater.join(", ")} as they are (changed after the run — fix them by hand)`,
		result.alreadyUndone.length && `${result.alreadyUndone.join(", ")} already undone`,
		result.notInRun.length && `${result.notInRun.join(", ")} not changed by this run`,
	].filter(Boolean);
	return `baton_undo run #${runNumber}: ${parts.join("; ") || "nothing to undo"}.`;
}
