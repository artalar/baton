import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModelRef } from "./config.ts";
import type { JudgeProvider } from "./judge.ts";

/** Jev (TypeSafe) judge through pi's classifier API (`modelRegistry.classify`). */
export function jevJudge(ctx: ExtensionContext, modelRef: string): JudgeProvider | undefined {
	const ref = parseModelRef(modelRef);
	const model = ref && ctx.modelRegistry.findOfType("classifier", ref.provider, ref.id);
	if (!model) return undefined;
	return {
		name: modelRef,
		async decide(request, signal) {
			const res = await ctx.modelRegistry.classify(model, { state: request.state as any, questions: request.questions }, { signal });
			if (res.stopReason !== "stop") return undefined;
			const out: Record<string, { choice: string; confidence: number }> = {};
			for (const [k, a] of Object.entries(res.answers)) if (a.type === "choice") out[k] = { choice: a.choice, confidence: a.confidence };
			return out;
		},
	};
}
