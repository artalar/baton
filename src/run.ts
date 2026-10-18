export interface RunCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	isError?: boolean;
	output?: string;
}

export interface ActiveRun {
	number: number;
	turns: number;
	calls: RunCall[];
}

export interface FinishedRun {
	number: number;
	stopReason: string;
	turns: number;
	callCount: number;
}

export const startRun = (number: number): ActiveRun => ({ number, turns: 0, calls: [] });

export function recordTurn(run: ActiveRun, calls: RunCall[]): void {
	run.turns++;
	run.calls.push(...calls);
}
