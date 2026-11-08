/**
 * History-dependent runouts (issue #53): coarser turn and river cards in the
 * rarely reached betting lines, every card in the rest.
 *
 * Purpose: the one place a chance node's runout set is chosen by the betting
 * before it, for `SpotConfig.lineRunouts`.
 *
 * Each chance node deals a FAMILY of boards. A family at a round is dealt
 * from one family of the round before, finely (every card, as
 * `enumerateRunouts` deals it) or coarsely (one stored card per class of
 * cards that do the same to the board's pairs, flushes and straights, within
 * a rank band). A chance node is coarse when the betting before it reaches
 * the rule's raise or aggression count, and stays coarse below a coarse one.
 * Families are stored one after another at each round, so a decision node's
 * boards are a contiguous range and storage is laid out as before; only the
 * boards of its own family take room.
 *
 * A coarse class plays every member card as its stored card, hands as they
 * are: each member deal walks the stored board with its own hands. That is
 * the card abstraction, and it miscounts card removal: a hand holding the
 * stored card is dead on it, so it misses every deal of the class, and a
 * hand holding another member is dealt it anyway. Each hand's chance value is
 * rescaled to the number of deals it really has (`lineScales`), which keeps
 * a hand's counterfactual value on the scale of its fold value; who it faces
 * on those deals is the stored board's.
 */

import type { HandSpace } from './hands.ts';
import type { ActiveLists } from './cfr.ts';
import { CardMaps } from './abstraction.ts';
import { DECK } from './cards.ts';
import type { RunoutFamily, RunoutLines, RunoutMerge, Runouts } from './runouts.ts';
import { connectivity, dealChildren } from './runouts.ts';
import type { Tree } from './tree.ts';
import { ActionKind, NodeKind } from './tree.ts';

/** Which lines deal coarse runouts; see `SpotConfig.lineRunouts`. */
export interface LineRunouts {
	/**
	 * Coarse below a chance node once the betting before it holds this many
	 * raises (a bet or shove facing a bet), all streets so far. Unset, never
	 * by raises.
	 */
	readonly raises?: number;
	/**
	 * Or this many aggressive actions, bets and raises alike. Unset, never by
	 * aggressions — unless `raises` is unset too, when it is 2.
	 */
	readonly aggressions?: number;
	/**
	 * Ranks per band among cards that pair nothing: 1 keeps every rank apart
	 * (suits fold only), 13 folds all ranks with the same flush and straight
	 * effect. Default 3.
	 */
	readonly band?: number;
}

/** What `lineRunouts: true` means: the rule measured as the best trade. */
export const DEFAULT_LINE_RUNOUTS: LineRunouts = { aggressions: 2, band: 3 };

/** A card's class on a board: what it does to pairs, flushes and straights, and its rank band. */
export function cardClass(cards: ArrayLike<number>, base: number, width: number, card: number, band: number): number {
	const rank = card >> 2;
	const suit = card & 3;
	let suited = 0;
	let pairs = false;
	const ranks = new Set<number>();
	for (let i = 0; i < width; i++) {
		const c = cards[base + i];
		ranks.add(c >> 2);
		if ((c & 3) === suit) suited++;
		if (c >> 2 === rank) pairs = true;
	}
	// A paired rank keeps its rank: trips and full houses differ too much.
	const rankKey = pairs ? 13 + rank : Math.floor(rank / band);
	return (rankKey * 5 + Math.min(suited, 4)) * 5 + connectivity(ranks, rank);
}

/** The transposition of two cards. */
function swapCards(a: number, b: number): Uint8Array {
	const out = new Uint8Array(DECK);
	for (let card = 0; card < DECK; card++) out[card] = card === a ? b : card === b ? a : card;
	return out;
}

/**
 * Board completions per betting line.
 *
 * @param board the board as given
 * @param symmetries as `enumerateRunouts`
 * @param merge as `enumerateRunouts`, in every family
 * @param tree the betting tree; only its chance nodes' histories matter
 * @param rule which lines deal coarsely
 */
export function enumerateLineRunouts(
	board: readonly number[],
	symmetries: readonly Uint8Array[] | undefined,
	merge: RunoutMerge | undefined,
	tree: Tree,
	rule: LineRunouts,
): Runouts {
	const band = rule.band ?? 3;
	if (!(Number.isInteger(band) && band >= 1 && band <= 13)) throw new Error(`lineRunouts.band must be 1 to 13; got ${band}`);
	const raisesAt = rule.raises;
	const aggressionsAt = rule.aggressions ?? (rule.raises === undefined ? 2 : undefined);
	for (const [key, value] of [['raises', raisesAt], ['aggressions', aggressionsAt]] as const) {
		if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
			throw new Error(`lineRunouts.${key} must be a whole number of actions; got ${value}`);
		}
	}
	const maps = new CardMaps();
	const group = (symmetries ?? []).map((map) => maps.add(map));
	if (group.length === 0 || group[0] !== 0) group.unshift(0);
	const rounds = 5 - board.length + 1;

	// Families, from the chance nodes' histories. A family is keyed by its
	// parent family and whether its deal is coarse.
	interface Draft { round: number; parent: number; coarse: boolean }
	const drafts: Draft[] = [{ round: 0, parent: -1, coarse: false }];
	const known = new Map<string, number>();
	const family = new Int32Array(tree.nodeCount).fill(-1);
	const chanceFamily = new Int32Array(tree.nodeCount).fill(-1);
	const coarseAt = (raises: number, aggressions: number): boolean =>
		(raisesAt !== undefined && raises >= raisesAt) || (aggressionsAt !== undefined && aggressions >= aggressionsAt);
	const walk = (node: number, fam: number, raises: number, aggressions: number, facing: boolean): void => {
		family[node] = fam;
		const kind = tree.kind[node];
		if (kind === NodeKind.TerminalFold || kind === NodeKind.TerminalShowdown) return;
		if (kind === NodeKind.Chance) {
			const coarse = drafts[fam].coarse || coarseAt(raises, aggressions);
			const key = `${fam}:${coarse}`;
			let next = known.get(key);
			if (next === undefined) {
				next = drafts.length;
				drafts.push({ round: tree.round[node] + 1, parent: fam, coarse });
				known.set(key, next);
			}
			chanceFamily[node] = next;
			walk(tree.edgeChild[tree.firstEdge[node]], next, raises, aggressions, false);
			return;
		}
		for (let e = 0; e < tree.numEdges[node]; e++) {
			const action = tree.edgeAction[tree.firstEdge[node] + e];
			const aggressive = action === ActionKind.Bet || action === ActionKind.Raise || action === ActionKind.AllIn;
			walk(
				tree.edgeChild[tree.firstEdge[node] + e], fam,
				raises + (aggressive && facing ? 1 : 0), aggressions + (aggressive ? 1 : 0), facing || aggressive,
			);
		}
	};
	walk(0, 0, 0, 0, false);

	const width: number[] = [board.length];
	const counts: number[] = [1];
	const cards: Uint8Array[] = [Uint8Array.from(board)];
	const parent: Int32Array[] = [Int32Array.of(-1)];
	const orbitStart: Int32Array[] = [Int32Array.of(0, 1)];
	const orbitMap: Int32Array[] = [Int32Array.of(0)];
	const orbitCard: Uint8Array[] = [new Uint8Array(1)];
	const orbitResolve: Int32Array[] = [Int32Array.of(0)];
	const stabiliserStart: Int32Array[] = [];
	const stabiliserMap: Int32Array[] = [];
	const recordStabilisers = (list: number[][]): void => {
		const starts = new Int32Array(list.length + 1);
		const flat: number[] = [];
		for (let b = 0; b < list.length; b++) {
			starts[b] = flat.length;
			flat.push(...list[b]);
		}
		starts[list.length] = flat.length;
		stabiliserStart.push(starts);
		stabiliserMap.push(Int32Array.from(flat));
	};
	let stabilisers: number[][] = [group];
	recordStabilisers(stabilisers);
	const families: RunoutFamily[] = [{ round: 0, parent: -1, coarse: false, from: 0, to: 1, childStart: new Int32Array(0) }];
	let symmetric = false;
	let approximate = false;

	for (let round = 1; round < rounds; round++) {
		const previousWidth = width[round - 1];
		const previousCards = cards[round - 1];
		const level: number[] = [];
		const parents: number[] = [];
		const memberStart: number[] = [0];
		const memberMap: number[] = [];
		const memberCard: number[] = [];
		const memberResolve: number[] = [];
		const nextStabilisers: number[][] = [];
		for (let f = 0; f < drafts.length; f++) {
			const draft = drafts[f];
			if (draft.round !== round) continue;
			const from = parents.length;
			const above = families[draft.parent];
			const starts = new Int32Array(counts[round - 1] + 1);
			for (let p = above.from; p < above.to; p++) {
				starts[p] = parents.length;
				const base = p * previousWidth;
				const children = dealChildren(maps, previousCards, base, previousWidth, stabilisers[p], merge);
				const resolve = children.map((child) => [...child.maps]);
				if (draft.coarse) {
					// One stored card per class, the middle one by rank; the
					// others play as it, hands unchanged.
					const byClass = new Map<number, number[]>();
					children.forEach((child, i) => {
						if (child.merged) return;
						const key = cardClass(previousCards, base, previousWidth, child.card, band);
						if (!byClass.has(key)) byClass.set(key, []);
						byClass.get(key)!.push(i);
					});
					for (const members of byClass.values()) {
						if (members.length < 2) continue;
						const keep = children[members[members.length >> 1]];
						const keepAt = members[members.length >> 1];
						for (const i of members) {
							if (i === keepAt) continue;
							const other = children[i];
							// Later cards relabel by swapping the two, so a real
							// deal of the stored card still finds a board.
							const swap = maps.add(swapCards(other.card, keep.card));
							for (let m = 0; m < other.maps.length; m++) {
								keep.maps.push(other.maps[m]);
								keep.cards.push(other.cards[m]);
								resolve[keepAt].push(maps.then(resolve[i][m], swap));
							}
							other.merged = true;
							approximate = true;
						}
					}
				}
				children.forEach((child, i) => {
					if (child.merged) {
						if (!draft.coarse) approximate = true;
						return;
					}
					for (let k = 0; k < previousWidth; k++) level.push(previousCards[base + k]);
					level.push(child.card);
					parents.push(p);
					memberMap.push(...child.maps);
					memberCard.push(...child.cards);
					memberResolve.push(...resolve[i]);
					memberStart.push(memberMap.length);
					nextStabilisers.push(child.fixing);
					if (child.maps.length > 1) symmetric = true;
				});
			}
			starts[above.to] = parents.length;
			families[f] = { round, parent: draft.parent, coarse: draft.coarse, from, to: parents.length, childStart: starts };
		}
		width.push(previousWidth + 1);
		counts.push(parents.length);
		cards.push(Uint8Array.from(level));
		parent.push(Int32Array.from(parents));
		orbitStart.push(Int32Array.from(memberStart));
		orbitMap.push(Int32Array.from(memberMap));
		orbitCard.push(Uint8Array.from(memberCard));
		orbitResolve.push(Int32Array.from(memberResolve));
		stabilisers = nextStabilisers;
		recordStabilisers(stabilisers);
	}

	// `childStart` as one view: each parent's children in the family that
	// continues its own, coarse after coarse and fine after fine.
	const childStart: Int32Array[] = [new Int32Array(0)];
	for (let round = 1; round < rounds; round++) {
		const starts = new Int32Array(counts[round - 1] + 1);
		for (const fam of families) {
			if (fam.round !== round) continue;
			const above = families[fam.parent];
			if (fam.coarse !== above.coarse && families.some((f) => f.parent === fam.parent && f.coarse === above.coarse)) continue;
			for (let p = above.from; p <= above.to; p++) starts[p] = fam.childStart[p];
		}
		childStart.push(starts);
	}

	const chanceStart: (Int32Array | null)[] = Array.from(chanceFamily, (f) => (f >= 0 ? families[f].childStart : null));
	const lines: RunoutLines = { family, chanceStart, families, orbitResolve };
	return {
		rounds, width, counts, cards, childStart, parent, orbitStart, orbitMap, orbitCard,
		stabiliserStart, stabiliserMap, maps, symmetric, approximate,
		initial: [...board],
		lines,
	};
}

/** Each decision node's boards at its round, `[from, to)`, for `buildLayout`. */
export function lineBoards(lines: RunoutLines, tree: Tree): { from: Int32Array; to: Int32Array } {
	const from = new Int32Array(tree.nodeCount);
	const to = new Int32Array(tree.nodeCount);
	for (let node = 0; node < tree.nodeCount; node++) {
		const fam = lines.families[lines.family[node]];
		if (!fam) continue;
		from[node] = fam.from;
		to[node] = fam.to;
	}
	return { from, to };
}

/** The children tables of the line through a node, per round up to its own: for `resolveBoard`. */
export function lineStarts(lines: RunoutLines, node: number): Int32Array[] {
	const out: Int32Array[] = [];
	for (let f = lines.family[node]; f >= 0; f = lines.families[f].parent) out[lines.families[f].round] = lines.families[f].childStart;
	return out;
}

/** A chance node's per-hand rescaling: `values[entry - base]` for entries of the parent round's lists. */
export interface LineScale {
	readonly base: number;
	readonly values: Float64Array;
}

/**
 * Per chance node, how much to scale each parent hand's value so it counts
 * the deals it really has; null where every hand already does, which is every
 * family a coarse class did not fold.
 */
export function lineScales(
	runouts: Runouts,
	tree: Tree,
	active: ActiveLists,
	hands: HandSpace,
): (LineScale | null)[] {
	const lines = runouts.lines!;
	const perFamily = lines.families.map((fam): LineScale | null => {
		if (fam.round === 0) return null;
		const round = fam.round;
		const above = lines.families[fam.parent];
		const base = active.start[active.roundBase[round - 1] * 2];
		const end = active.start[active.roundBase[round] * 2];
		const counted = new Float64Array(end - base);
		// What every hand is dealt: the deck less the board and its own two cards.
		const expected = DECK - runouts.width[round - 1] - 2;
		let exact = true;
		for (let p = above.from; p < above.to; p++) {
			for (let player = 0; player < 2; player++) {
				const slot = (active.roundBase[round - 1] + p) * 2 + player;
				const from = active.start[slot];
				const count = active.count[slot];
				for (let child = fam.childStart[p]; child < fam.childStart[p + 1]; child++) {
					const childSlot = (active.roundBase[round] + child) * 2 + player;
					const childFrom = active.start[childSlot];
					const childCount = active.count[childSlot];
					for (let m = runouts.orbitStart[round][child]; m < runouts.orbitStart[round][child + 1]; m++) {
						const up = hands.upStart[round][m * 2 + player];
						for (let k = 0; k < childCount; k++) {
							counted[from - base + hands.up[up + k]] += active.multiplicity[childFrom + k];
						}
					}
				}
				for (let i = 0; i < count; i++) {
					const deals = counted[from - base + i] / active.multiplicity[from + i];
					const scale = deals > 0 ? expected / deals : 1;
					if (scale !== 1) exact = false;
					counted[from - base + i] = scale;
				}
			}
		}
		return exact ? null : { base, values: counted };
	});
	const out: (LineScale | null)[] = new Array(tree.nodeCount).fill(null);
	for (let node = 0; node < tree.nodeCount; node++) {
		const start = lines.chanceStart[node];
		if (start === null) continue;
		out[node] = perFamily[lines.families.findIndex((f) => f.childStart === start)];
	}
	return out;
}
