/**
 * Safe and nested subgame re-solving (issue #47).
 *
 * Purpose: refine one player's strategy below a node of a solved spot — a
 * blueprint whose later streets were simplified to fit — by solving that
 * subgame again with a richer tree, without handing the opponent a way to
 * exploit the change. Opt-in: nothing else in the solver calls this.
 *
 * `Solution.subgameAt` already builds the subgame; solving it as it stands is
 * unsafe re-solving: the opponent's range is taken as fixed, so the new
 * strategy is free to give back value against hands the blueprint already
 * defended, and an opponent who reaches the node with a different mix of
 * hands than the blueprint expected collects it. A gadget (Burch, Johanson &
 * Bowling, 2014; Moravčík et al., 2016; Brown & Sandholm, 2017) lets the
 * opponent, before the subgame, take what each hand was worth against the
 * blueprint instead of entering. The re-solved player then cannot let any
 * hand do better than that without the solve pushing back:
 *
 * - 'resolve': each opponent hand chooses, by regret matching, between its
 *   blueprint value and entering the subgame; it enters with its blueprint
 *   reach times the probability of entering.
 * - 'maxmargin': the opponent picks which hand to enter with, a distribution
 *   over its hands learned by regret matching on each hand's margin — its
 *   subgame value minus its blueprint value — so the re-solve maximises the
 *   smallest margin. The blueprint reach only says which hands can arrive.
 * - 'reach-maxmargin': as 'maxmargin', but each hand's blueprint value is
 *   raised by what it gave up on the way to the node: at each of its
 *   decisions on the path, the best alternative's value minus the taken
 *   action's, when positive. Value the opponent already left on the table
 *   can be spent without letting it gain over the blueprint overall.
 * - 'unsafe': no gadget; the same as solving `subgameAt` directly.
 *
 * Blueprint values are, by default, the opponent's best response to the
 * blueprint below the node (and below each alternative on the path), which is
 * what the safety guarantee is stated for; `values: 'blueprint'` uses the
 * blueprint's own values instead, Brown & Sandholm's "estimate" variants.
 *
 * Re-solving refines one player: the gadget guards against the other. To read
 * both players' strategies at a node, re-solve it once for each.
 *
 * Nested: a re-solved subgame is a `Solution` like any other, so a node below
 * it can be re-solved from it in turn. 'reach-maxmargin' then counts only
 * the gifts on the path inside that subgame: what the opponent gave up on
 * earlier streets, in the solve the subgame came from, is not carried in.
 *
 * Measured (issue #47; Ks 9s 4s, a flop blueprint with three flop sizes and
 * one turn/river size, its turns re-solved at three sizes with raises,
 * against a full-tree reference): an opponent's best response under the
 * reference's ranges gained, weighted by how often each turn is reached,
 * about 3.5–4% of the subgame's pot against 'unsafe', 4.2–4.6% against
 * 'resolve' and 4.7–6.2% against the maxmargin gadgets. Most of what is
 * left is the refined player's own range at the node, which comes from the
 * blueprint and which no gadget changes; and with more actions in the
 * subgame than in the blueprint, the guarantees often cannot all be met,
 * so pushing toward them moves the strategy away from equilibrium. Hence
 * 'unsafe' is the default; the gadgets are there for blueprints whose
 * subgame betting matches their own, where they hold (see the tests).
 */

import { COMBO_CARDS, COMBOS } from './cards.ts';
import type { Solution, SolveOptions, SubgameBetting } from './index.ts';
import { createRun, defineSpot } from './index.ts';
import { boardAtRound } from './runouts.ts';
import type { Context } from './cfr.ts';
import { makeBuffers, Mode, traverse } from './cfr.ts';
import { NodeKind } from './tree.ts';

/** How a re-solve guards the refined player; see the module comment. */
export type Gadget = 'unsafe' | 'resolve' | 'maxmargin' | 'reach-maxmargin';

/** Settings for {@link resolveSubgame}. */
export interface ResolveOptions {
	/** The player whose strategy is refined; the gadget guards against the other. */
	readonly player: 0 | 1;
	/**
	 * Default 'unsafe', which measured best on issue #47's bench: under the
	 * reference's ranges an opponent gained less against it than against any
	 * safe gadget, because most of a re-solve's error is the refined
	 * player's own range at the node, which no gadget changes.
	 */
	readonly gadget?: Gadget;
	/** The subgame's betting; unset, the blueprint's carries over. */
	readonly betting?: SubgameBetting;
	/**
	 * What each opponent hand is guaranteed: its best response to the
	 * blueprint below the node ('best-response', the default and the safe
	 * choice), or its value under the blueprint ('blueprint').
	 */
	readonly values?: 'best-response' | 'blueprint';
	/**
	 * Iterations to run. Default 200. There is no exploitability target: the
	 * subgame's exploitability means little inside a gadget, where opponent
	 * hands that take their blueprint value stop training their own play.
	 */
	readonly iterations?: number;
	/**
	 * Also report `alternative` and `entered` with 'unsafe', at the cost of a
	 * best-response pass over the blueprint below the node and one over the
	 * subgame. The gadgets need them and always report them.
	 */
	readonly measure?: boolean;
	/** Solver settings for the subgame; `iterations` and warm starts are this function's. */
	readonly solve?: Pick<SolveOptions, 'workers' | 'precision' | 'algorithm' | 'engine' | 'simd'>;
}

/** A re-solved subgame. */
export interface ResolvedSubgame {
	/**
	 * The subgame's solution. Its ranges are the ones the blueprint brings to
	 * the node; read the refined player's strategy from it.
	 */
	readonly solution: Solution;
	readonly player: 0 | 1;
	readonly gadget: Gadget;
	/**
	 * Each opponent hand's guaranteed value at the node — what it had
	 * against the blueprint, gifts included — in chips, indexed like
	 * `COMBO_CARDS`; NaN off its range. Null for 'unsafe' unless `measure`.
	 */
	readonly alternative: Float64Array | null;
	/**
	 * Each opponent hand's best-response value in the re-solved subgame
	 * against the refined strategy, in chips; NaN off its range. Where it
	 * exceeds `alternative` the re-solve gave that hand more than the
	 * blueprint did. Null for 'unsafe' unless `measure`.
	 */
	readonly entered: Float64Array | null;
	/** What each opponent hand gave up on the path ('reach-maxmargin'), in chips, else null. */
	readonly gifts: Float64Array | null;
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
	const gadget = options.gadget ?? 'unsafe';
	const { player } = options;
	const opponent = (1 - player) as 0 | 1;
	const iterations = options.iterations ?? 200;
	if (!(Number.isInteger(iterations) && iterations > 0)) {
		throw new Error(`iterations must be a positive whole number; got ${iterations}`);
	}
	const spot = defineSpot(blueprint.subgameAt(node, board, options.betting));
	const measured = gadget !== 'unsafe' || options.measure === true;
	const mode = options.values === 'blueprint' ? Mode.Average : Mode.BestResponse;
	const base = spot.players[opponent].weights.slice();
	const mine = spot.players[player].weights;
	// Mass of the refined player's range each opponent hand does not block.
	const open = measured ? openMass(mine) : null;

	// The blueprint's values below the node, worked out before the
	// subgame's storage and threads are taken.
	const live = liveCombos(spot.players);
	const blueprintValues = open ? valuesBelow(blueprint, node, board, opponent, base, mine, live, mode) : null;
	const gifts = open && gadget === 'reach-maxmargin' ? pathGifts(blueprint, node, board, opponent, mode) : null;

	const run = createRun(spot, { ...options.solve });
	try {
		const { ctx } = run.solver;
		// The opponent's root hands in the subgame, as the traversal lists them.
		const lists = ctx.active;
		const slot = lists.roundBase[0] * 2 + opponent;
		const from = lists.start[slot];
		const count = lists.count[slot];
		const deals = ctx.runoutWeight[0];
		const openOf = new Float64Array(count);
		if (open) for (let i = 0; i < count; i++) openOf[i] = open[lists.list[from + i]];

		// The blueprint's value for each opponent hand at the node, in chips.
		let alternative: Float64Array | null = null;
		if (open && blueprintValues) {
			alternative = new Float64Array(COMBOS).fill(Number.NaN);
			for (const combo of live) {
				if (base[combo] > 0 && open[combo] > 0) alternative[combo] = blueprintValues[combo] / (open[combo] * deals);
			}
			if (gifts) for (let combo = 0; combo < COMBOS; combo++) alternative[combo] += gifts[combo];
		}

		// Per root entry: the blueprint value and the gadget's regrets.
		const alt = new Float64Array(count);
		const usable = new Uint8Array(count);
		for (let i = 0; i < count; i++) {
			const combo = lists.list[from + i];
			usable[i] = alternative && base[combo] > 0 && openOf[i] > 0 && Number.isFinite(alternative[combo]) ? 1 : 0;
			alt[i] = usable[i] ? alternative![combo] : 0;
		}
		const value = new Float64Array(count);
		const regretEnter = new Float64Array(count);
		const regretTake = new Float64Array(count);
		const regretPick = new Float64Array(count);
		const baseMass = base.reduce((sum, w) => sum + w, 0);
		const members = (i: number): number => lists.memberStart[from + i + 1] - lists.memberStart[from + i];

		// The opponent's reach into the subgame under the gadget's current strategy.
		const setReach = (): void => {
			if (gadget === 'resolve') {
				for (let i = 0; i < count; i++) {
					const enter = regretEnter[i] + regretTake[i] > 0 ? regretEnter[i] / (regretEnter[i] + regretTake[i]) : 0.5;
					for (let m = lists.memberStart[from + i]; m < lists.memberStart[from + i + 1]; m++) {
						const combo = lists.memberCombo[m];
						weights[combo] = base[combo] * enter;
					}
				}
				return;
			}
			// Maxmargin: a distribution over hands, each entering against the
			// refined range as chance deals it: weighted by 1 / open mass, so
			// every hand counts by its value per hand, not its reach.
			let positive = 0;
			let live = 0;
			for (let i = 0; i < count; i++) {
				if (!usable[i]) continue;
				positive += members(i) * regretPick[i];
				live += members(i);
			}
			let mass = 0;
			for (let i = 0; i < count; i++) {
				const pick = !usable[i] ? 0 : positive > 0 ? regretPick[i] / positive : 1 / live;
				for (let m = lists.memberStart[from + i]; m < lists.memberStart[from + i + 1]; m++) {
					const combo = lists.memberCombo[m];
					weights[combo] = pick > 0 ? pick / openOf[i] : 0;
					mass += weights[combo];
				}
			}
			// The same total as the blueprint's, so iterations weigh alike.
			const scale = mass > 0 ? baseMass / mass : 0;
			for (let combo = 0; combo < COMBOS; combo++) weights[combo] *= scale;
		};

		// The gadget's update, from the opponent's values this iteration.
		const update = (values: Float64Array): void => {
			for (let i = 0; i < count; i++) value[i] = usable[i] ? values[i] / (openOf[i] * deals) : 0;
			if (gadget === 'resolve') {
				for (let i = 0; i < count; i++) {
					if (!usable[i]) continue;
					const total = regretEnter[i] + regretTake[i];
					const enter = total > 0 ? regretEnter[i] / total : 0.5;
					const mean = enter * value[i] + (1 - enter) * alt[i];
					regretEnter[i] = Math.max(0, regretEnter[i] + value[i] - mean);
					regretTake[i] = Math.max(0, regretTake[i] + alt[i] - mean);
				}
				return;
			}
			let positive = 0;
			let live = 0;
			for (let i = 0; i < count; i++) {
				if (!usable[i]) continue;
				positive += members(i) * regretPick[i];
				live += members(i);
			}
			let mean = 0;
			for (let i = 0; i < count; i++) {
				if (!usable[i]) continue;
				const pick = positive > 0 ? regretPick[i] / positive : 1 / live;
				mean += members(i) * pick * (value[i] - alt[i]);
			}
			for (let i = 0; i < count; i++) {
				if (usable[i]) regretPick[i] = Math.max(0, regretPick[i] + value[i] - alt[i] - mean);
			}
		};

		const weights = spot.players[opponent].weights;
		const restore = (): void => {
			weights.set(base);
		};
		let gadgetOn = gadget !== 'unsafe';
		// Wrap the traversal: before the refined player trains, set the
		// opponent's reach; after the opponent trains, update the gadget.
		const inner = run.solver.root;
		run.solver.useRoot((pass, traverser, weight) => {
			if (!gadgetOn || pass !== Mode.Train) return inner(pass, traverser, weight);
			if (traverser === player) setReach();
			const values = inner(pass, traverser, weight);
			if (traverser === opponent) update(values);
			return values;
		});
		try {
			run.step(iterations);
		} finally {
			restore();
			gadgetOn = false;
		}

		// Each opponent hand's best response to the refined strategy.
		let entered: Float64Array | null = null;
		if (measured) {
			const response = run.solver.root(Mode.BestResponse, opponent, 0);
			entered = new Float64Array(COMBOS).fill(Number.NaN);
			for (let i = 0; i < count; i++) {
				if (!usable[i]) continue;
				const chips = response[i] / (openOf[i] * deals);
				for (let m = lists.memberStart[from + i]; m < lists.memberStart[from + i + 1]; m++) entered[lists.memberCombo[m]] = chips;
			}
		}
		return { solution: run.snapshot(), player, gadget, alternative, entered, gifts, iterations };
	} finally {
		run.close();
	}
}

/**
 * Each of `traverser`'s hands' value below `node`, in raw units: under the
 * blueprint's average strategy, or best-responding to the other player's.
 */
function valuesBelow(
	blueprint: Solution,
	node: number,
	board: number,
	traverser: 0 | 1,
	reachMe: Float64Array,
	reachOpp: Float64Array,
	live: Uint16Array,
	mode: typeof Mode.Average | typeof Mode.BestResponse,
): Float64Array {
	if (mode === Mode.Average) return blueprint.solver.valuesAt(node, board, traverser, reachMe, reachOpp, live, live.length);
	return bestResponseAt(blueprint.solver.ctx, node, board, traverser, reachMe, reachOpp);
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

/** `reach` with every combination using a card of `board` removed. */
function offBoard(reach: Float64Array, board: ArrayLike<number>): Float64Array {
	const out = reach.slice();
	const used = new Uint8Array(52);
	for (let i = 0; i < board.length; i++) used[board[i]] = 1;
	for (let h = 0; h < COMBOS; h++) if (used[COMBO_CARDS[h * 2]] || used[COMBO_CARDS[h * 2 + 1]]) out[h] = 0;
	return out;
}

/**
 * What each of `opponent`'s hands gave up on the way to `node`, in chips: at
 * each of their decisions on the path, the best action's value minus the
 * taken one's, where positive, each per hand reaching that decision.
 *
 * Adding a decision's gift to the hand's value at every node below the taken
 * action raises its value at the decision by at most the gift, since those
 * nodes' probabilities from there sum to at most one.
 */
function pathGifts(
	blueprint: Solution,
	node: number,
	board: number,
	opponent: 0 | 1,
	mode: typeof Mode.Average | typeof Mode.BestResponse,
): Float64Array {
	const { tree, runouts } = blueprint.spot;
	const player = (1 - opponent) as 0 | 1;
	const gifts = new Float64Array(COMBOS);
	// The path, child by child, from the root.
	const parent = new Int32Array(tree.nodeCount).fill(-1);
	for (let n = 0; n < tree.nodeCount; n++) {
		for (let e = 0; e < tree.numEdges[n]; e++) parent[tree.edgeChild[tree.firstEdge[n] + e]] = n;
	}
	const round = tree.round[node];
	for (let child = node; parent[child] >= 0; child = parent[child]) {
		const at = parent[child];
		if (tree.kind[at] !== NodeKind.Decision || tree.player[at] !== opponent) continue;
		const atBoard = boardAtRound(runouts, board, round, tree.round[at]);
		const width = runouts.width[tree.round[at]];
		const cards = runouts.cards[tree.round[at]].subarray(atBoard * width, atBoard * width + width);
		const theirs = offBoard(blueprint.reachAt(at, atBoard, opponent), cards);
		const mine = offBoard(blueprint.reachAt(at, atBoard, player), cards);
		const open = openMass(mine);
		const live = liveCombos([{ weights: theirs }, { weights: mine }]);
		const deals = blueprint.solver.ctx.runoutWeight[tree.round[at]];
		const best = new Float64Array(COMBOS).fill(-Infinity);
		let taken: Float64Array | null = null;
		for (let e = 0; e < tree.numEdges[at]; e++) {
			const next = tree.edgeChild[tree.firstEdge[at] + e];
			const values = valuesBelow(blueprint, next, atBoard, opponent, theirs, mine, live, mode);
			for (const combo of live) if (values[combo] > best[combo]) best[combo] = values[combo];
			if (next === child) taken = values;
		}
		for (const combo of live) {
			if (!(theirs[combo] > 0) || !(open[combo] > 0)) continue;
			const gap = (best[combo] - taken![combo]) / (open[combo] * deals);
			if (gap > 0) gifts[combo] += gap;
		}
	}
	return gifts;
}
