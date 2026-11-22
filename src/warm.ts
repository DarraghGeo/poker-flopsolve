/**
 * Warm starts.
 *
 * Purpose: begin a solve from a previous one's regrets and strategy sums
 * instead of from nothing.
 *
 * A tweaked spot — a different pot, a bet size nudged, a range reweighted —
 * has nearly the same equilibrium as the one before, so starting there costs
 * a fraction of the iterations. Nothing about the answer is approximate: CFR
 * converges from any starting point, and this one is merely close.
 *
 * What carries over is the regrets — they ARE the current strategy, which is
 * what a nearby equilibrium shares — and, only for the very same spot, the
 * average strategy too, so a solve can be resumed exactly.
 *
 * The two trees are walked together from the root. A decision matches when
 * the same player acts in the same round; its actions match by kind, and bets
 * and raises by the chips they add as a fraction of the pot, the nearest
 * within a factor of `SIZE_TOLERANCE`. Whatever matches nothing starts cold. Boards match by
 * their real cards, so two spots may store different runouts (one folding
 * mirrored deals, the other not); hands match by combination, so a range may
 * have grown or shrunk.
 *
 * A solve of another board can seed this one through a card relabelling — a
 * permutation of the deck taking one board onto the other, a rank swap for a
 * nearby flop — through which its runouts and hands are read.
 */

import type { Context, RegretStore, SumStore } from './cfr.ts';
import { COMPACT_SUM_STEPS, regretMatch, scaleExponent, SHIFT_SCALE } from './cfr.ts';
import { COMBO_CARDS, COMBOS, DECK, comboIndex } from './cards.ts';
import { markMembers } from './hands.ts';
import { playsAs } from './nested.ts';
import type { Runouts } from './runouts.ts';
import { resolveBoard } from './runouts.ts';
import type { Tree } from './tree.ts';
import { ActionKind, NodeKind } from './tree.ts';

/** Largest ratio between two bet sizes, as pot fractions, still taken as the same. */
export const SIZE_TOLERANCE = 1.35;

export const REGRET_STEPS = 32767;
export const SUM_STEPS = 65535;

/** What a warm start carried over. */
export interface WarmStartReport {
	/** Decision nodes of the new tree that found a match in the old one. */
	readonly matchedNodes: number;
	readonly decisionNodes: number;
	/**
	 * Whether the average strategy was carried over too. Only for the very
	 * same spot: the average of another spot's iterations would have to be
	 * outweighed before the new spot's own could show, and measured, that
	 * costs more than it saves — a pot 20% bigger took 475 iterations to
	 * reach 0.1% of pot carrying it, 100 without, 125 from cold.
	 */
	readonly averages: boolean;
	/**
	 * Whether regrets were carried over: false where either side keeps none
	 * (an `analysisOnly` run). With `averages` false as well, nothing was.
	 */
	readonly regrets: boolean;
}

/** How two trees pair up; see `matchTrees`. */
export interface TreeMatch {
	/** Each decision node of `to`'s counterpart in `from`, or -1. */
	readonly match: Int32Array;
	/** For each matched node of `to`, which of the old node's actions each of its actions continues, or -1. */
	readonly actions: Map<number, Int32Array>;
}

/**
 * Pair each decision node of `to` with its counterpart in `from`, and each
 * of its actions with the old action it continues.
 *
 * The trees are walked together, each player's investment kept along the
 * way: a bet or raise is measured by the chips it adds, as a share of the
 * pot it is made into. An edge's own target is the actor's whole investment,
 * earlier streets included, and measured by that, sizes drew together as
 * the pot grew: after a flop bet and call, a third of the pot on the turn
 * was taken for half of it.
 */
export function matchTrees(to: Tree, from: Tree, tolerance: number): TreeMatch {
	const match = new Int32Array(to.nodeCount).fill(-1);
	const actions = new Map<number, Int32Array>();
	const limit = Math.log(tolerance);
	const walk = (a: number, b: number, mine: readonly [number, number], theirs: readonly [number, number]): void => {
		if (to.kind[a] !== from.kind[b] || to.round[a] !== from.round[b]) return;
		if (to.kind[a] === NodeKind.Chance) {
			walk(to.edgeChild[to.firstEdge[a]], from.edgeChild[from.firstEdge[b]], mine, theirs);
			return;
		}
		if (to.kind[a] !== NodeKind.Decision || to.player[a] !== from.player[b]) return;
		match[a] = b;
		const actor = to.player[a];
		const actionOf = new Int32Array(to.numEdges[a]).fill(-1);
		actions.set(a, actionOf);
		for (let e = 0; e < to.numEdges[a]; e++) {
			const edge = to.firstEdge[a] + e;
			const kind = to.edgeAction[edge];
			const sized = kind === ActionKind.Bet || kind === ActionKind.Raise;
			const size = (to.edgeTarget[edge] - mine[actor]) / to.pot[a];
			let best = -1;
			let bestGap = Infinity;
			for (let o = 0; o < from.numEdges[b]; o++) {
				const candidate = from.firstEdge[b] + o;
				if (from.edgeAction[candidate] !== kind) continue;
				if (!sized) {
					best = candidate;
					bestGap = 0;
					break;
				}
				const gap = Math.abs(Math.log((from.edgeTarget[candidate] - theirs[actor]) / from.pot[b] / size));
				if (gap < bestGap) {
					bestGap = gap;
					best = candidate;
				}
			}
			if (best < 0 || !(bestGap <= limit)) continue;
			actionOf[e] = best - from.firstEdge[b];
			// A check or a fold has no target; anything else leaves the actor at its own.
			const after = (invested: readonly [number, number], target: number): [number, number] =>
				actor === 0 ? [Math.max(invested[0], target), invested[1]] : [invested[0], Math.max(invested[1], target)];
			walk(to.edgeChild[edge], from.edgeChild[best], after(mine, to.edgeTarget[edge]), after(theirs, from.edgeTarget[best]));
		}
	};
	walk(0, 0, [0, 0], [0, 0]);
	return { match, actions };
}

/**
 * Pair each decision node of `to` with its counterpart in `from`, or -1.
 */
export function matchNodes(to: Tree, from: Tree, tolerance = SIZE_TOLERANCE): Int32Array {
	return matchTrees(to, from, tolerance).match;
}

/** Read one block — a node on a board — as plain numbers, `actions * count` of them. */
export function readBlock(
	store: RegretStore | SumStore,
	scale: Float64Array | null,
	block: number,
	base: number,
	length: number,
	out: Float64Array,
): void {
	const factor = scale ? scale[block] : 1;
	for (let i = 0; i < length; i++) out[i] = store[base + i] * factor;
}

/** Write one block, re-encoding it when storage is 16-bit. */
export function writeBlock(
	store: RegretStore | SumStore,
	scale: Float64Array | null,
	steps: number,
	block: number,
	base: number,
	length: number,
	values: Float64Array,
): void {
	if (!scale) {
		for (let i = 0; i < length; i++) store[base + i] = values[i];
		return;
	}
	let largest = 0;
	for (let i = 0; i < length; i++) {
		const magnitude = Math.abs(values[i]);
		if (magnitude > largest) largest = magnitude;
	}
	const step = largest > 0 ? steps / largest : 0;
	for (let i = 0; i < length; i++) store[base + i] = Math.round(values[i] * step);
	scale[block] = largest / steps;
}

/**
 * Read a compactly stored block as plain numbers: the regrets, unless
 * `regrets` is null, and the strategy sums. Where compact storage keeps no
 * sums its strategy is the current profile, so that is what comes back as
 * the sums: any positive multiple of a strategy averages to it.
 */
export function readCompactBlock(
	ctx: Context,
	node: number,
	listSlot: number,
	block: number,
	base: number,
	actions: number,
	count: number,
	regrets: Float64Array | null,
	sums: Float64Array,
): void {
	const plan = ctx.compact!;
	const chunk = ctx.layout.compactChunk![node];
	const q = ctx.compactRegret![chunk];
	const handBase = ctx.layout.handOffset![node] + ctx.layout.rowStart[listSlot];
	const shifts = plan.perHand ? ctx.handShift![chunk] : null;
	const blockScale = !plan.perHand && !plan.float ? ctx.compactScale![block] : 1;
	for (let i = 0; i < count; i++) {
		const scale = shifts ? SHIFT_SCALE[shifts[handBase + i]] : blockScale;
		if (regrets) for (let a = 0; a < actions; a++) regrets[a * count + i] = q[base + a * count + i] * scale;
		if (!plan.sums) continue;
		const sumScale = SHIFT_SCALE[ctx.sumShift![chunk][handBase + i]];
		const stored = ctx.compactSum![chunk];
		for (let a = 0; a < actions; a++) sums[a * count + i] = stored[base + a * count + i] * sumScale;
	}
	if (!plan.sums) regretMatch(q, base, actions, count, sums);
}

/**
 * Write a compactly stored block, encoding it as compact storage does but
 * rounded to nearest: the regrets unless `regrets` is null, the sums where it
 * keeps them unless `sums` is null.
 */
export function writeCompactBlock(
	ctx: Context,
	node: number,
	listSlot: number,
	block: number,
	base: number,
	actions: number,
	count: number,
	regrets: Float64Array | null,
	sums: Float64Array | null,
): void {
	const plan = ctx.compact!;
	const chunk = ctx.layout.compactChunk![node];
	const q = ctx.compactRegret![chunk];
	const handBase = ctx.layout.handOffset![node] + ctx.layout.rowStart[listSlot];
	const steps = plan.steps;
	const fit = (value: number, top: number, bottom: number): number => {
		const rounded = Math.round(value);
		return rounded > top ? top : rounded < bottom ? bottom : rounded;
	};
	if (regrets && plan.float) {
		for (let k = 0; k < actions * count; k++) q[base + k] = regrets[k];
	} else if (regrets && !plan.perHand) {
		let largest = 0;
		for (let k = 0; k < actions * count; k++) largest = Math.max(largest, Math.abs(regrets[k]));
		const step = largest > 0 ? steps / largest : 0;
		for (let k = 0; k < actions * count; k++) q[base + k] = fit(regrets[k] * step, steps, -steps);
		ctx.compactScale![block] = largest / steps;
	} else if (regrets) {
		const shifts = ctx.handShift![chunk];
		for (let i = 0; i < count; i++) {
			let largest = 0;
			for (let a = 0; a < actions; a++) largest = Math.max(largest, Math.abs(regrets[a * count + i]));
			const exponent = scaleExponent(largest, steps);
			shifts[handBase + i] = exponent;
			const inverse = exponent === 0 ? 0 : 1 / SHIFT_SCALE[exponent];
			for (let a = 0; a < actions; a++) q[base + a * count + i] = fit(regrets[a * count + i] * inverse, steps, -steps);
		}
	}
	if (!sums || !plan.sums) return;
	const stored = ctx.compactSum![chunk];
	const shifts = ctx.sumShift![chunk];
	for (let i = 0; i < count; i++) {
		let largest = 0;
		for (let a = 0; a < actions; a++) largest = Math.max(largest, sums[a * count + i]);
		const exponent = scaleExponent(largest, COMPACT_SUM_STEPS);
		shifts[handBase + i] = exponent;
		const inverse = exponent === 0 ? 0 : 1 / SHIFT_SCALE[exponent];
		for (let a = 0; a < actions; a++) stored[base + a * count + i] = fit(sums[a * count + i] * inverse, COMPACT_SUM_STEPS, 0);
	}
}

/** The real cards of a stored board. */
export function realCards(runouts: Runouts, round: number, board: number): number[] {
	const width = runouts.width[round];
	return Array.from(runouts.cards[round].subarray(board * width, (board + 1) * width));
}

/**
 * Seed `to` from `from`. Both must be built on the same board, unless `cards`
 * relabels one onto the other.
 *
 * @param cards for a solve of a different board: each card of `to` to the card
 *   of `from` it plays as, a permutation of the deck taking `to`'s board onto
 *   `from`'s. Hands and dealt cards map through it too. Unset, the identity.
 * @param tolerance largest ratio between two bet sizes still matched; unset,
 *   `SIZE_TOLERANCE`. `Infinity` maps every bet to the nearest one of its kind,
 *   which seeds a size the old tree lacked from its neighbour.
 * @returns what matched
 * @throws if the boards differ, or `cards` does not take one onto the other
 */
export function warmStart(
	to: Context,
	from: Context,
	averages: boolean,
	cards?: Uint8Array,
	tolerance = SIZE_TOLERANCE,
): WarmStartReport {
	if (!(tolerance >= 1)) throw new Error(`warmStart: the size tolerance is a ratio of at least 1, not ${tolerance}`);
	// Each node is copied on its own, so into shared storage every history of
	// a group would overwrite the same block and the last would win. From
	// shared storage the copy is exact: each node takes its owner's block.
	if (to.layout.shared && !from.layout.shared) {
		throw new Error('A spot with shareHistories can only warm-start from a solve that shares histories too');
	}
	const a = to.runouts.initial;
	const b = from.runouts.initial;
	if (cards) checkRelabelling(cards, a, b);
	// The same cards, in whatever order each spot was given them.
	else if (a.length !== b.length || a.some((card) => !b.includes(card))) {
		throw new Error('A warm start must come from a solve of the same board, unless `warmCards` relabels one onto the other');
	}
	// A real board of `to` as `from` sees it: its own given board first, in
	// its order, then the dealt cards relabelled.
	const asSource = (real: number[]): number[] =>
		[...b, ...real.slice(a.length).map((card) => (cards ? cards[card] : card))];
	// Each hand of `to` as the hand of `from` it plays as.
	const comboOf = new Uint16Array(COMBOS);
	for (let combo = 0; combo < COMBOS; combo++) {
		comboOf[combo] = cards ? comboIndex(cards[COMBO_CARDS[combo * 2]], cards[COMBO_CARDS[combo * 2 + 1]]) : combo;
	}
	const { match, actions: actionsOf } = matchTrees(to.tree, from.tree, tolerance);
	const { tree } = to;
	// Wide enough for a block of either tree: an old node is read whole, and may have more actions than any new one.
	const width = Math.max(to.layout.maxActions, from.layout.maxActions) * COMBOS;
	const oldRegret = new Float64Array(width);
	const oldSum = new Float64Array(width);
	const newRegret = new Float64Array(width);
	const newSum = new Float64Array(width);
	// An analysis-only run has none; compact storage may keep all of its regrets compactly.
	const keepsRegrets = (ctx: Context): boolean => ctx.regret.length > 0 || (ctx.compactRegret ?? null) !== null;
	const hasRegret = keepsRegrets(to) && keepsRegrets(from);

	// The matched nodes of each round and owner, and which old action each of
	// their actions continues. What follows is laid out board by board: a
	// board is resolved once, and each player's hands on it placed in the old
	// list once, for every node of the round, where doing both again for
	// each node was most of a warm start's time.
	const rounds = to.runouts.rounds;
	const nodesOf: number[][] = Array.from({ length: rounds * 2 }, () => []);
	let matched = 0;
	for (const node of tree.decisionNodes) {
		if (match[node] < 0) continue;
		matched++;
		nodesOf[tree.round[node] * 2 + tree.player[node]].push(node);
	}

	// A combination's position in the old board's hand list, or -1.
	const position = new Int32Array(COMBOS).fill(-1);
	// For each hand a new entry stands for, in order, its position in the old list.
	const sourceOf = new Int32Array(COMBOS);
	const sourceEnd = new Int32Array(COMBOS);
	for (let round = 0; round < rounds; round++) {
		if (nodesOf[round * 2].length + nodesOf[round * 2 + 1].length === 0) continue;
		for (let board = 0; board < to.runouts.counts[round]; board++) {
			const resolved = resolveBoard(from.runouts, asSource(realCards(to.runouts, round, board)));
			for (let owner = 0; owner < 2; owner++) {
				const nodes = nodesOf[round * 2 + owner];
				if (nodes.length === 0) continue;
				// Blocks are laid out by position in each board's hand list.
				const oldSlot = (from.active.roundBase[round] + resolved.board) * 2 + owner;
				const oldFrom = from.active.start[oldSlot];
				const oldCount = from.active.count[oldSlot];
				const newSlot = (to.active.roundBase[round] + board) * 2 + owner;
				const newFrom = to.active.start[newSlot];
				const count = to.active.count[newSlot];
				// Every hand an old entry stands for is at that entry.
				const thinned = from.kept != null && from.kept.rounds[round] === 1;
				if (thinned) playsAs(from.kept!, from.runouts, from.active, round, resolved.board, owner, position);
				else markMembers(from.active, oldFrom, oldCount, position, false);
				let sources = 0;
				for (let i = 0; i < count; i++) {
					for (let m = to.active.memberStart[newFrom + i]; m < to.active.memberStart[newFrom + i + 1]; m++) {
						sourceOf[sources++] = position[resolved.combos[comboOf[to.active.memberCombo[m]]]];
					}
					sourceEnd[i] = sources;
				}
				if (thinned) position.fill(-1);
				else markMembers(from.active, oldFrom, oldCount, position, true);

				// Plain storage on both sides and one old hand for each new one:
				// the usual case, copied store to store.
				const direct =
					sources === count && round < from.layout.compactFrom && round < to.layout.compactFrom &&
					from.regretScale === null && to.regretScale === null;

				for (const node of nodes) {
					const old = match[node];
					const actions = tree.numEdges[node];
					const oldActions = from.tree.numEdges[old];
					const actionOf = actionsOf.get(node)!;
					const oldBlock = from.layout.blockOffset[old] + resolved.board;
					const oldBase = from.layout.offset[old] + oldActions * from.layout.rowStart[oldSlot];
					const oldLength = oldActions * oldCount;
					if (direct) {
						const base = to.layout.offset[node] + actions * to.layout.rowStart[newSlot];
						if (hasRegret) copyRows(to.regret, base, from.regret, oldBase, actionOf, count, oldCount, sourceOf);
						if (averages) copyRows(to.strategySum, base, from.strategySum, oldBase, actionOf, count, oldCount, sourceOf);
						continue;
					}
					if (round >= from.layout.compactFrom) {
						readCompactBlock(from, old, oldSlot, oldBlock, oldBase, oldActions, oldCount, hasRegret ? oldRegret : null, oldSum);
					} else {
						if (hasRegret) readBlock(from.regret, from.regretScale, oldBlock, oldBase, oldLength, oldRegret);
						if (averages) readBlock(from.strategySum, from.sumScale, oldBlock, oldBase, oldLength, oldSum);
					}

					const length = actions * count;
					newRegret.fill(0, 0, length);
					if (averages) newSum.fill(0, 0, length);
					for (let e = 0; e < actions; e++) {
						const action = actionOf[e];
						if (action < 0) continue;
						const row = e * count;
						const oldRow = action * oldCount;
						let first = 0;
						for (let i = 0; i < count; i++) {
							// An entry stands for its mirror orbit here, which the old solve
							// may have stored apart and not played alike: it takes their mean.
							const end = sourceEnd[i];
							const share = 1 / (end - first);
							for (let k = first; k < end; k++) {
								const j = sourceOf[k];
								if (j < 0) continue;
								if (hasRegret) newRegret[row + i] += share * oldRegret[oldRow + j];
								if (averages) newSum[row + i] += share * oldSum[oldRow + j];
							}
							first = end;
						}
					}

					const block = to.layout.blockOffset[node] + board;
					const base = to.layout.offset[node] + actions * to.layout.rowStart[newSlot];
					if (round >= to.layout.compactFrom) {
						writeCompactBlock(to, node, newSlot, block, base, actions, count, hasRegret ? newRegret : null, averages ? newSum : null);
					} else {
						if (hasRegret) writeBlock(to.regret, to.regretScale, REGRET_STEPS, block, base, length, newRegret);
						if (averages) writeBlock(to.strategySum, to.sumScale, SUM_STEPS, block, base, length, newSum);
					}
				}
			}
		}
	}
	return { matchedNodes: matched, decisionNodes: tree.decisionNodes.length, averages, regrets: hasRegret };
}

/**
 * Copy a block between plain stores: each new action's row from the old
 * action it continues, each hand from its place in the old list, and zero
 * where there is none.
 */
function copyRows(
	to: RegretStore | SumStore,
	base: number,
	from: RegretStore | SumStore,
	oldBase: number,
	actionOf: Int32Array,
	count: number,
	oldCount: number,
	sourceOf: Int32Array,
): void {
	for (let e = 0; e < actionOf.length; e++) {
		const action = actionOf[e];
		const row = base + e * count;
		if (action < 0) {
			to.fill(0, row, row + count);
			continue;
		}
		const oldRow = oldBase + action * oldCount;
		for (let i = 0; i < count; i++) {
			const j = sourceOf[i];
			to[row + i] = j < 0 ? 0 : from[oldRow + j];
		}
	}
}

/** Throw unless `cards` is a permutation of the deck taking board `a` onto board `b`. */
function checkRelabelling(cards: Uint8Array, a: readonly number[], b: readonly number[]): void {
	const seen = new Uint8Array(DECK);
	if (cards.length !== DECK) throw new Error(`A card relabelling maps all ${DECK} cards; got ${cards.length}`);
	for (const card of cards) {
		if (card >= DECK || seen[card]) throw new Error('A card relabelling must be a permutation of the deck');
		seen[card] = 1;
	}
	const target = new Set(b);
	if (a.length !== b.length || a.some((card) => !target.has(cards[card]))) {
		throw new Error('The card relabelling must take the board onto the warm start\'s board');
	}
}
