/**
 * Measurements shared by `reference.ts` and `run.ts` (issue #47).
 */

import { COMBO_CARDS, COMBOS, NodeKind, parseCards } from '../../src/index.ts';
import type { Solution, SpotConfig } from '../../src/index.ts';
import { Mode } from '../../src/cfr.ts';

/** Per-combination values, NaN where undefined; JSON keeps NaN as null. */
export type Vec = number[];

export const toJson = (v: ArrayLike<number>): (number | null)[] => Array.from(v, (x) => (Number.isFinite(x) ? x : null));
export const fromJson = (v: readonly (number | null)[]): number[] => v.map((x) => (x === null ? Number.NaN : x));

/** For each combination, the mass of `range` it does not block. */
export function openMass(range: ArrayLike<number>): Float64Array {
	const card = new Float64Array(52);
	let total = 0;
	for (let h = 0; h < COMBOS; h++) {
		total += range[h];
		card[COMBO_CARDS[h * 2]] += range[h];
		card[COMBO_CARDS[h * 2 + 1]] += range[h];
	}
	const open = new Float64Array(COMBOS);
	for (let h = 0; h < COMBOS; h++) open[h] = Math.max(0, total - card[COMBO_CARDS[h * 2]] - card[COMBO_CARDS[h * 2 + 1]] + range[h]);
	return open;
}

/** `reach` with combinations using a card of `cards` zeroed. */
export function offCards(reach: ArrayLike<number>, cards: ArrayLike<number>): Float64Array {
	const out = Float64Array.from(reach);
	const used = new Set(Array.from(cards));
	for (let h = 0; h < COMBOS; h++) if (used.has(COMBO_CARDS[h * 2]) || used.has(COMBO_CARDS[h * 2 + 1])) out[h] = 0;
	return out;
}

const liveOf = (a: ArrayLike<number>, b: ArrayLike<number>): Uint16Array => {
	const live: number[] = [];
	for (let h = 0; h < COMBOS; h++) if (a[h] > 0 || b[h] > 0) live.push(h);
	return Uint16Array.from(live);
};

/**
 * Per-combination EV in chips of `player` from `node` on `board`, for the
 * given reaches, under the average strategy (or best response).
 */
export function nodeEvs(
	sol: Solution,
	node: number,
	board: number,
	player: 0 | 1,
	reachMe: Float64Array,
	reachOpp: Float64Array,
	mode: typeof Mode.Average | typeof Mode.BestResponse = Mode.Average,
): Float64Array {
	const live = liveOf(reachMe, reachOpp);
	const values = sol.solver.valuesAt(node, board, player, reachMe, reachOpp, live, live.length, mode);
	const open = openMass(reachOpp);
	const deals = sol.solver.ctx.runoutWeight[sol.spot.tree.round[node]];
	const out = new Float64Array(COMBOS).fill(Number.NaN);
	for (let h = 0; h < COMBOS; h++) if (reachMe[h] > 0 && open[h] > 0) out[h] = values[h] / (open[h] * deals);
	return out;
}

/** Root EV per combination of each player, % of pot. */
export function rootEvs(sol: Solution): [Vec, Vec] {
	const pot = sol.spot.potUnits / sol.spot.chipScale;
	const w = [sol.spot.players[0].weights, sol.spot.players[1].weights];
	return ([0, 1] as const).map((p) => Array.from(nodeEvs(sol, 0, 0, p, w[p], w[1 - p]), (x) => (100 * x) / pot)) as [Vec, Vec];
}

/** A root-level decision's per-action EVs: OOP at the root, IP after a check. */
export interface ActionEvs {
	readonly player: 0 | 1;
	readonly actions: readonly string[];
	/** evs[a][combo], % of pot. */
	readonly evs: Vec[];
	/** The acting player's reach there. */
	readonly reach: Vec;
	/** probs[a][combo]: the average strategy there. */
	readonly probs: Vec[];
}

export function rootActionEvs(sol: Solution): ActionEvs[] {
	const { tree } = sol.spot;
	const pot = sol.spot.potUnits / sol.spot.chipScale;
	const out: ActionEvs[] = [];
	const check = tree.edgeChild[tree.firstEdge[0]];
	for (const [node, player] of [[0, 0], [check, 1]] as const) {
		const me = sol.reachAt(node, 0, player);
		const opp = sol.reachAt(node, 0, (1 - player) as 0 | 1);
		const view = sol.strategyAt(node, 0);
		const evs: Vec[] = [];
		for (let e = 0; e < tree.numEdges[node]; e++) {
			const child = tree.edgeChild[tree.firstEdge[node] + e];
			evs.push(Array.from(nodeEvs(sol, child, 0, player, me, opp), (x) => (100 * x) / pot));
		}
		const probs: Vec[] = view.actions.map(() => new Array<number>(COMBOS).fill(Number.NaN));
		for (let i = 0; i < view.combos.length; i++) {
			for (let a = 0; a < view.actions.length; a++) probs[a][view.combos[i]] = view.probs[i * view.actions.length + a];
		}
		out.push({ player, actions: view.actions, evs, reach: Array.from(me), probs });
	}
	return out;
}

/** The node opening the turn after `line`, or throw. */
export function lineNode(sol: Solution, line: string): number {
	const { tree } = sol.spot;
	for (let node = 0; node < tree.nodeCount; node++) {
		if (tree.kind[node] !== NodeKind.Chance || tree.round[node] !== 0) continue;
		const child = tree.edgeChild[tree.firstEdge[node]];
		if (sol.path(child) === line) return child;
	}
	throw new Error(`no line ${line}`);
}

/** The stored board index of the flop plus `turn`. */
export function turnBoard(sol: Solution, turn: string): number {
	const resolved = sol.spot.resolveBoard([...sol.spot.board, ...parseCards(turn)]);
	return resolved.board;
}

/** A subgame config as JSON (ranges as arrays). */
export function configToJson(config: SpotConfig): unknown {
	return JSON.parse(JSON.stringify(config, (_, v: unknown) => (v instanceof Float64Array ? Array.from(v) : v)));
}
export function configFromJson(json: Record<string, unknown>): SpotConfig {
	return { ...json, oop: Float64Array.from(json.oop as number[]), ip: Float64Array.from(json.ip as number[]) } as unknown as SpotConfig;
}
