import { createHash } from "node:crypto";

/**
 * Conservative chars-per-token ratio, calibrated on real advisor calls (Claude Opus 5.5 via OpenRouter,
 * Tetris-on-Reatom run, 2026-10-13): packs of code + skills + diff measured 2.43-2.61 "estimate units"
 * per real input token with chars/3.2 under-counting by 23-32%. 2.4 keeps the pack budget safe.
 */
export const CHARS_PER_TOKEN = 2.4;

/** Conservative token estimate used everywhere in Baton: chars / 2.4, non-ASCII counted twice. */
export function estimateTokens(text: string): number {
	let nonAscii = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) nonAscii++;
	// Non-ASCII chars (Cyrillic, CJK, emoji) cost roughly one token per 1-2 chars: count them twice.
	return Math.ceil((text.length + nonAscii) / CHARS_PER_TOKEN);
}

/** Inverse of estimateTokens for ASCII text: how many chars fit into `tokens`. */
export function charsForTokens(tokens: number): number {
	return Math.floor(tokens * CHARS_PER_TOKEN);
}

/** Minimal glob → RegExp: `**` (any depth), `*` (no slash), `?`. Anchored, POSIX separators. */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				const slash = glob[i + 2] === "/";
				re += slash ? "(?:.*/)?" : ".*";
				i += slash ? 2 : 1;
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
	}
	return new RegExp(`^${re}$`);
}

/** True when the (relative or absolute) path matches any of the globs. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
	const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
	return globs.some((g) => globToRegExp(g).test(p));
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
