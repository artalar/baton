import { createTwoFilesPatch } from "diff";
import { type FileChange, FILE_TOOLS, type RunCall, type UndoResult } from "./run.ts";

export const HARNESS = "[Baton]";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const OUTPUT_TAIL_CHARS = 2_000;

export const LEAD_SYSTEM_NOTE = `

# Baton: speculative runs
You are the lead model in this session. To save cost, after each of your turns that ends with tool calls, a cheaper helper model continues your work in this same session (a speculative run): it sees everything you see and makes the next tool calls of your current plan until it reaches a point that needs you.
You never see the helper's messages. After a run you get a message starting with "${HARNESS} Speculative run #N". The harness builds it from facts only: the helper's tool calls in order, read outputs verbatim, the status and output tail of other calls, and the exact diff of the files it changed with edit/write. Those changes are already on disk.
Decide what to do with each run as part of your next step:
- Keep it: continue from where it stopped. Do not redo or re-read what the note already shows.
- Fix it: edit the files yourself, as with your own work.
- Undo it: baton_undo({run: N}) restores every file the run changed with edit/write; add paths: [...] to undo only some files. File changes made through bash are not undone.
The helper reads your messages. To steer later runs, say it in one sentence in your reply, e.g. "Helper: do not touch the tests" or "Helper: stop after this edit".
The work is yours: run whatever verification (tests, typecheck, build) the task needs before your final answer. The harness runs no checks for you.`;

export function helperInstruction(runNumber: number): string {
	return [
		`${HARNESS} Speculative run #${runNumber}. You are now the helper model, not the lead. The "Baton" section of the system prompt describes the lead's side.`,
		"Continue the lead's current work from exactly where it stopped: make the next tool calls the lead would make for its current plan. The lead reviews everything you do and can keep, fix or undo it.",
		`- Follow the lead's plan, names and interfaces. Do not redesign, do not start work the lead has not planned, and follow any "Helper:" instructions in the lead's messages.`,
		"- Never delete, skip or weaken tests, and never rewrite code you did not write in this run; make targeted edits.",
		"- Read with read/grep/find/ls. Change files only with edit/write: the lead reviews their diff, and file changes made through bash are invisible to it. Use bash to run commands; do not pipe checks through tail/grep, the lead sees the output tail anyway. Batch independent calls in one turn.",
		"- Running the checks the plan calls for and fixing what they report is welcome.",
		"- Stop, with one short line and no tool call, when the planned step is done, when the next step needs a design decision, the user, or anything the lead has not decided, or when you are unsure. Stopping early is cheap; going the wrong way is expensive.",
		"- Do not write a final answer for the user. The lead does not see your messages, only your tool calls and their results.",
	].join("\n");
}

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
	const status = call.output === undefined ? "no result" : call.isError ? "error" : "ok";
	const line = `${index + 1}. ${describeCall(call)} → ${status}`;
	const output = call.output?.trim();
	if (!output) return line;
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
	noteChars: number;
}

export function renderRunNote({ runNumber, helperModel, stopReason, turns, calls, changes, noteChars }: RunNoteInput): string {
	const helperName = helperModel.split("/").pop();
	const header = `${HARNESS} Speculative run #${runNumber} by the helper model (${helperName}), not by you. Its file changes are already on disk.\nIt stopped because ${stopReason}: ${turns} turn(s), ${calls.length} tool call(s).`;
	const footer = "Continue from here: keep the run, fix it, or undo it.";

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
	const bashCaveat = calls.some((call) => call.name === "bash") ? "\nBash commands above may also have changed files; such changes are not in this diff." : "";

	const draftCalls = (shown: Set<RunCall>) => `Tool calls:\n${calls.map((call, index) => callLine(call, index, shown.has(call))).join("\n") || "(none)"}`;
	const fixedChars = header.length + draftCalls(new Set(reads.map((read) => read.call))).length + filesSection.length + bashCaveat.length + footer.length + 40;
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
		filesSection + bashCaveat,
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
