import { isSameModel } from "./config.ts";

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export interface CostRow {
	model: string;
	turns: number;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	largestTurnCost: number;
}

export function addUsage(rows: Record<string, CostRow>, model: string, usage: Usage | undefined): Record<string, CostRow> {
	const row = rows[model] ?? { model, turns: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, largestTurnCost: 0 };
	const turnCost = usage?.cost?.total ?? 0;
	return {
		...rows,
		[model]: {
			model,
			turns: row.turns + 1,
			cost: row.cost + turnCost,
			input: row.input + (usage?.input ?? 0),
			output: row.output + (usage?.output ?? 0),
			cacheRead: row.cacheRead + (usage?.cacheRead ?? 0),
			cacheWrite: row.cacheWrite + (usage?.cacheWrite ?? 0),
			largestTurnCost: Math.max(row.largestTurnCost, turnCost),
		},
	};
}

export interface Spend {
	lead: number;
	helper: number;
	other: number;
	total: number;
	largestLeadTurn: number;
}

/** Lead and helper costs as reported by the provider; `otherUsd` covers Jev calls. Unknown models count as lead spend. */
export function spendOf(rows: Record<string, CostRow>, helperModel: string, helperCostFactor: number, otherUsd: number): Spend {
	let lead = 0;
	let helper = 0;
	let largestLeadTurn = 0;
	for (const row of Object.values(rows)) {
		if (isSameModel(row.model, helperModel)) helper += row.cost;
		else {
			lead += row.cost;
			largestLeadTurn = Math.max(largestLeadTurn, row.largestTurnCost);
		}
	}
	return { lead, helper, other: otherUsd, total: lead + helper * helperCostFactor + otherUsd, largestLeadTurn };
}

export type BudgetLevel = "unlimited" | "ok" | "wrapUp" | "exhausted";

/**
 * "wrapUp": what is left only covers the lead finishing — no new speculative runs, and the lead is told to finish.
 * "exhausted": the budget is spent; the run is aborted.
 */
export function budgetLevel(spend: Spend, budgetUsd: number, reserveUsd: number): BudgetLevel {
	if (budgetUsd <= 0) return "unlimited";
	if (spend.total >= budgetUsd) return "exhausted";
	const reserve = Math.max(reserveUsd, spend.largestLeadTurn * 2);
	return spend.total + reserve >= budgetUsd ? "wrapUp" : "ok";
}
