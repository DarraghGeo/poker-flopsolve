/**
 * Nested subgame re-solving (issue #47).
 *
 * Purpose: refine one player's strategy below a node of a solved spot — a
 * blueprint whose later streets were simplified to fit — by solving that
 * subgame again with a richer tree. Opt-in: nothing else in the solver calls
 * this.
 *
 * `Solution.subgameAt` already builds the subgame; this solves it with the
 * ranges the blueprint brings to the node held fixed (unsafe re-solving), and
 * can measure what each opponent hand gets against the result next to what it
 * had against the blueprint.
 *
 * Nested: a re-solved subgame is a `Solution` like any other, so a node below
 * it can be re-solved from it in turn.
 *
 * Measured (issue #47; Ks 9s 4s, a flop blueprint with three flop sizes and
 * one turn/river size, its turns re-solved at three sizes with raises,
 * against a full-tree reference): an opponent's best response under the
 * reference's ranges gained, weighted by how often each turn is reached,
 * about 3.5–4% of the subgame's pot against plain re-solving, and more
 * against every safe gadget tried (4.2–6.2%: Burch, Johanson & Bowling's
 * re-solve gadget and Moravčík et al.'s and Brown & Sandholm's maxmargin
 * ones). Most of what is left is the refined player's own range at the node,
 * which comes from the blueprint and which no gadget changes, so the gadgets
 * were removed before 0.5.0 (issue #125). To make re-solves from a shared
 * blueprint trustworthy, keep the busiest lines unshared
 * (`ShareHistories.keepLines` with `linesWithin`).
 */

import { COMBO_CARDS, COMBOS } from './cards.ts';
import type { Solution, SolveOptions, SubgameBetting } from './index.ts';
import { createRun, defineSpot } from './index.ts';
import type { Context } from './cfr.ts';
import { makeBuffers, Mode, traverse } from './cfr.ts';

/** Settings for {@link resolveSubgame}. */
export interface ResolveOptions {
	/** The player whose strategy is refined. */
	readonly player: 0 | 1;
	/** The subgame's betting; unset, the blueprint's carries over. */
	readonly betting?: SubgameBetting;
	/** Iterations to run. Default 200. */
	readonly iterations?: number;
	/**
	 * Also report `alternative` and `entered`, at the cost of a best-response
	 * pass over the blueprint below the node and one over the subgame.
	 */
	readonly measure?: boolean;
	/** Solver settings for the subgame; `iterations` and warm starts are this function's. */
	readonly solve?: Pick<SolveOptions, 'workers' | 'precision' | 'algorithm' | 'engine' | 'simd' | 'wasmStorage'>;
}

/** A re-solved subgame. */
export interface ResolvedSubgame {
	/**
	 * The subgame's solution. Its ranges are the ones the blueprint brings to
	 * the node; read the refined player's strategy from it.
	 */
	readonly solution: Solution;
	readonly player: 0 | 1;
	/**
	 * Each opponent hand's best-response value at the node against the
	 * blueprint, in chips on `Solver.valuesAt`'s half-pot baseline (not
	 * `Solution.ev`'s share of the pot), indexed like `COMBO_CARDS`; NaN off
	 * its range.
	 * Null unless `measure`.
	 */
	readonly alternative: Float64Array | null;
	/**
	 * Each opponent hand's best-response value in the re-solved subgame
	 * against the refined strategy, in chips; NaN off its range. Where it
	 * exceeds `alternative` the re-solve gave that hand more than the
	 * blueprint did. Null unless `measure`.
	 */
	readonly entered: Float64Array | null;
	readonly iterations: number;
}

/**
 * Re-solve the subgame at a node of `blueprint` for one player.
 *
 * @param blueprint a solved spot
 * @param node a decision opening a betting round (see `Solution.subgameAt`)
 * @param board the board index at that node's round
 */
export function resolveSubgame(blueprint: Solution, node: number, board: number, options: ResolveOptions): ResolvedSubgame {
	const { player } = options;
	const opponent = (1 - player) as 0 | 1;
	const iterations = options.iterations ?? 200;
	if (!(Number.isInteger(iterations) && iterations > 0)) {
		throw new Error(`iterations must be a positive whole number; got ${iterations}`);
	}
	const spot = defineSpot(blueprint.subgameAt(node, board, options.betting));
	const base = spot.players[opponent].weights;
	const mine = spot.players[player].weights;
	// Mass of the refined player's range each opponent hand does not block.
	const open = options.measure === true ? openMass(mine) : null;

	// The blueprint's values below the node, worked out before the
	// subgame's storage and threads are taken.
	const live = liveCombos(spot.players);
	const blueprintValues = open ? bestResponseAt(blueprint.solver.ctx, node, board, opponent, base, mine) : null;

	const run = createRun(spot, { ...options.solve });
	try {
		run.step(iterations);
		let alternative: Float64Array | null = null;
		let entered: Float64Array | null = null;
		if (open && blueprintValues) {
			const { ctx } = run.solver;
			const deals = ctx.runoutWeight[0];
			alternative = new Float64Array(COMBOS).fill(Number.NaN);
			for (const combo of live) {
				if (base[combo] > 0 && open[combo] > 0) alternative[combo] = blueprintValues[combo] / (open[combo] * deals);
			}
			// Each opponent hand's best response to the refined strategy, by
			// the traversal's root hands.
			const lists = ctx.active;
			const slot = lists.roundBase[0] * 2 + opponent;
			const from = lists.start[slot];
			const response = run.solver.root(Mode.BestResponse, opponent, 0);
			entered = new Float64Array(COMBOS).fill(Number.NaN);
			for (let i = 0; i < lists.count[slot]; i++) {
				const combo = lists.list[from + i];
				if (!Number.isFinite(alternative[combo])) continue;
				const chips = response[i] / (open[combo] * deals);
				for (let m = lists.memberStart[from + i]; m < lists.memberStart[from + i + 1]; m++) entered[lists.memberCombo[m]] = chips;
			}
		}
		return { solution: run.snapshot(), player, alternative, entered, iterations };
	} finally {
		run.close();
	}
}

/**
 * Best-response values below `node`, as `Solver.valuesAt` gives average
 * ones. A best response is not linear in the opponent's reach, so the reach
 * must be the same for mirrored hands, as any reach a solve produces is.
 */
export function bestResponseAt(ctx: Context, node: number, board: number, traverser: 0 | 1, reachMe: Float64Array, reachOpp: Float64Array): Float64Array {
	const lists = ctx.active;
	const round = ctx.tree.round[node];
	const listOf = (player: 0 | 1): [number, number] => {
		const slot = (lists.roundBase[round] + board) * 2 + player;
		return [lists.start[slot], lists.count[slot]];
	};
	const gather = (source: Float64Array, player: 0 | 1): Float64Array => {
		const [from, count] = listOf(player);
		const into = new Float64Array(COMBOS);
		for (let i = 0; i < count; i++) into[i] = source[lists.list[from + i]];
		return into;
	};
	const opponent = (1 - traverser) as 0 | 1;
	const [oppFrom, oppCount] = listOf(opponent);
	for (let j = 0; j < oppCount; j++) {
		const own = reachOpp[lists.list[oppFrom + j]];
		for (let m = lists.memberStart[oppFrom + j] + 1; m < lists.memberStart[oppFrom + j + 1]; m++) {
			if (reachOpp[lists.memberCombo[m]] !== own) throw new Error('Best-response values need reach that mirrored hands share');
		}
	}
	// Mirrored deals below need not see symmetric reach, so they are walked.
	const expanded = ctx.expandOrbits;
	ctx.expandOrbits = true;
	try {
		const buffers = makeBuffers(ctx.tree, ctx.layout.maxActions, ctx.simd);
		const value = traverse(ctx, buffers, Mode.BestResponse, traverser, 0, node, board, gather(reachMe, traverser), gather(reachOpp, opponent), 0);
		const result = new Float64Array(COMBOS);
		const [from, count] = listOf(traverser);
		for (let i = 0; i < count; i++) {
			for (let m = lists.memberStart[from + i]; m < lists.memberStart[from + i + 1]; m++) result[lists.memberCombo[m]] = value[i];
		}
		return result;
	} finally {
		ctx.expandOrbits = expanded;
	}
}

/** Combinations either player holds. */
function liveCombos(players: readonly { readonly weights: Float64Array }[]): Uint16Array {
	const live: number[] = [];
	for (let combo = 0; combo < COMBOS; combo++) {
		if (players[0].weights[combo] > 0 || players[1].weights[combo] > 0) live.push(combo);
	}
	return Uint16Array.from(live);
}

/**
 * For each combination, the mass of `range` it does not block. Summed
 * directly rather than by inclusion-exclusion over cards, so a hand with
 * nothing to face gets exactly zero, not a rounding residue that passes a
 * `> 0` check and is then divided by.
 */
export function openMass(range: Float64Array): Float64Array {
	const held: number[] = [];
	for (let h = 0; h < COMBOS; h++) if (range[h] > 0) held.push(h);
	const open = new Float64Array(COMBOS);
	for (let h = 0; h < COMBOS; h++) {
		const a = COMBO_CARDS[h * 2];
		const b = COMBO_CARDS[h * 2 + 1];
		let mass = 0;
		for (const other of held) {
			const c = COMBO_CARDS[other * 2];
			const d = COMBO_CARDS[other * 2 + 1];
			if (c !== a && c !== b && d !== a && d !== b) mass += range[other];
		}
		open[h] = mass;
	}
	return open;
}
