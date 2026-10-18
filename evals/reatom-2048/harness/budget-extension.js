const limitUsd = Number(process.env.RUN_BUDGET_USD ?? 3);
const limitMs = Number(process.env.RUN_LIMIT_MS ?? 20 * 60 * 1000);

export default function budgetLimit(pi) {
	let usd = 0;
	const startedAt = Date.now();

	const overLimit = () => usd >= limitUsd || Date.now() - startedAt >= limitMs;

	const reason = () =>
		`Run limit reached ($${usd.toFixed(3)} of $${limitUsd.toFixed(2)}, ${Math.round((Date.now() - startedAt) / 1000)}s of ${Math.round(limitMs / 1000)}s). Stop now. Do not make more tool calls. Summarize what you finished.`;

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message?.role !== "assistant") return;
		usd += Number(message.usage?.cost?.total ?? 0);
	});

	pi.on("tool_call", () => {
		if (!overLimit()) return;
		return { block: true, terminate: true, reason: reason() };
	});
}
