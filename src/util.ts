import { createHash } from "node:crypto";

/** Rough token estimate used everywhere in Baton: chars / 4. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function sha1(text: string): string {
	return createHash("sha1").update(text).digest("hex");
}

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Keep the first `head` and last `tail` lines; mark the cut. */
export function headTail(text: string, head: number, tail: number): string {
	const lines = text.split("\n");
	if (lines.length <= head + tail) return text;
	const cut = lines.length - head - tail;
	return [...lines.slice(0, head), `… [${cut} lines cut] …`, ...lines.slice(lines.length - tail)].join("\n");
}

/** Hard character cap that keeps the start and the end. */
export function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const half = Math.max(0, Math.floor((maxChars - 30) / 2));
	return `${text.slice(0, half)}\n… [${text.length - 2 * half} chars cut] …\n${text.slice(text.length - half)}`;
}

export function oneLine(text: string, max = 200): string {
	const s = text.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
