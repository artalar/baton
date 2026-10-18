const BASH_TIMEOUT_SEC = 60;

export default function bashTimeout(pi) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;
		const requested = Number(event.input?.timeout);
		event.input.timeout = Number.isFinite(requested) && requested > 0 ? Math.min(requested, BASH_TIMEOUT_SEC) : BASH_TIMEOUT_SEC;
	});
}
