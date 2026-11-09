/**
 * Score a solution against napkinpoker's reference solves (issue #103).
 *
 * Purpose: one yardstick for every approximation, on every board texture.
 * At each stored node (flop decisions up to three actions in; the first turn
 * decision after each stored turn card) our average strategy is valued at the
 * reference's per-action EVs, which are exact action against action (see the
 * fixture README): the EV our play gives up against each hand's best stored
 * action is the regret we leave, in the reference's game.
 *
 * - `scoreSolution(sol, spot)`: every stored node of a spot, plus a summary.
 * - `scoreSubgame(sub, node)`: a `resolveSubgame` solution at its turn root.
 * - `crossCheck(sol, spot)`: our own per-action EVs against the stored ones,
 *   for checking an exact solve of the same game.
 *
 * Every number here is in % of the pot at the node (`NapkinNode.pot`, which
 * counts any bet faced), weighted by the stored actor's reach per hand, and
 * only at nodes whose opponent reach is at least `MIN_REACH`; the stored
 * values are noisy below that.
 */

import { COMBO_CARDS, COMBOS, parseCards } from '../../src/cards.ts';
import type { Solution } from '../../src/index.ts';
import { openMass } from '../../src/resolve.ts';
import type { NapkinNode } from './napkinpoker.ts';
import { matchLabel, napkinNodes, nodeAt, pairActions } from './napkinpoker.ts';

/** Opponent reach below which a stored node is not scored (fixture README). */
export const MIN_REACH = 0.03;

/** Share of a node's reach a hand must hold to count toward a maximum. */
export const WELL_HELD = 0.002;

/** One stored node, scored. Losses are in % of the node's pot. */
export interface NodeScore {
	readonly id: string;
	readonly path: string;
	readonly street: 'flop' | 'turn';
	readonly actor: 0 | 1;
	readonly reach: readonly [number, number];
	/**
	 * EV our strategy gives up at the stored EVs: per hand, its best stored
	 * action's EV minus the EV of our mix, reach-weighted mean.
	 */
	readonly loss: number;
	/** The same for the stored strategy itself: the reference's own noise floor. */
	readonly refLoss: number;
	/**
	 * Per-hand regret difference between our play and the stored play, at the
	 * stored EVs: |EV(our mix) − EV(stored mix)| per hand, reach-weighted mean.
	 */
	readonly handDiff: number;
	/** Largest per-hand loss among hands holding at least `WELL_HELD` of the node's reach. */
	readonly maxLoss: number;
	/** Total variation between our mix and the stored one, reach-weighted, 0 to 1. */
	readonly strategyDiff: number;
}

/** A spot's nodes, scored, and their summary. */
export interface SpotScore {
	readonly spot: string;
	readonly nodes: readonly NodeScore[];
	/** Stored nodes scored for, but not in this solution's tree (thinned or simplified away). */
	readonly missing: readonly string[];
	/** OOP at the flop root, and IP after a check: the root play. */
	readonly root: { readonly oop: NodeScore | null; readonly ip: NodeScore | null };
	/** Means over the scored nodes of each street (unweighted), % of the node's pot. */
	readonly flop: Summary;
	readonly turn: Summary;
}

export interface Summary {
	readonly nodes: number;
	readonly loss: number;
	readonly refLoss: number;
	readonly handDiff: number;
}

/** Our probability per stored action and real combination, for one node. */
type Mix = (action: number, combo: number) => number;

/**
 * Score one stored node given how we play it.
 *
 * @param mix our probability of stored action `a` (by the stored order) for a real combination
 * @param has whether our tree offers stored action `a`; unset, every one
 */
export function scoreNode(stored: NapkinNode, street: 'flop' | 'turn', mix: Mix, has: (action: number) => boolean = () => true): NodeScore {
	const actions = stored.actions.length;
	let mass = 0;
	let loss = 0;
	let refLoss = 0;
	let handDiff = 0;
	let tv = 0;
	let maxLoss = 0;
	let total = 0;
	for (let i = 0; i < stored.combos.length; i++) total += stored.weight[i];
	for (let i = 0; i < stored.combos.length; i++) {
		const w = stored.weight[i];
		if (!(w > 0)) continue;
		let best = -Infinity;
		let ok = true;
		for (let a = 0; a < actions; a++) {
			const ev = stored.ev[a][i];
			if (!Number.isFinite(ev)) ok = false;
			else best = Math.max(best, ev);
		}
		if (!ok) continue;
		const combo = stored.combos[i];
		let ours = 0;
		let theirs = 0;
		let diff = 0;
		let sum = 0;
		for (let a = 0; a < actions; a++) sum += mix(a, combo);
		// A hand we hold no strategy for plays uniformly over the actions we have.
		let held = 0;
		for (let a = 0; a < actions; a++) if (has(a)) held++;
		for (let a = 0; a < actions; a++) {
			const p = sum > 0 ? mix(a, combo) / sum : has(a) ? 1 / held : 0;
			ours += p * stored.ev[a][i];
			theirs += stored.strategy[a][i] * stored.ev[a][i];
			diff += Math.abs(p - stored.strategy[a][i]);
		}
		const lost = best - ours;
		mass += w;
		loss += w * lost;
		refLoss += w * (best - theirs);
		handDiff += w * Math.abs(ours - theirs);
		tv += (w * diff) / 2;
		if (w >= WELL_HELD * total) maxLoss = Math.max(maxLoss, lost);
	}
	const pct = 100 / stored.pot;
	return {
		id: stored.id,
		path: stored.path.join(','),
		street,
		actor: stored.actor,
		reach: stored.reach,
		loss: (pct * loss) / mass,
		refLoss: (pct * refLoss) / mass,
		handDiff: (pct * handDiff) / mass,
		maxLoss: pct * maxLoss,
		strategyDiff: tv / mass,
	};
}

/** Where a stored node sits in a solution: its node, stored board and hand relabelling. */
export interface Located {
	readonly node: number;
	readonly board: number;
	/** Real combination → the combination it plays as on the stored board. */
	readonly relabel: Uint16Array;
	/** Stored action `a` → our edge offset at the node, -1 where we lack it. */
	readonly pairing: number[];
}

/**
 * Each stored action's index among ours, -1 where we lack it; null if we have
 * an action the stored solver lacks (our play there has no stored value).
 */
export function pairSubset(labels: readonly string[], stored: readonly string[]): number[] | null {
	const out = stored.map((action) => matchLabel(labels, action));
	const used = out.filter((i) => i >= 0);
	if (new Set(used).size !== used.length || used.length !== labels.length) return null;
	return out;
}

/**
 * Find a stored node in a solution whose spot starts at the stored spot's
 * root (`prefix` 0) or `prefix` steps down the stored path. Null where the
 * solution's tree does not hold the node, or offers an action the stored one
 * lacks: a thinned or simplified tree. With `strict`, both throw instead, and
 * the menus must match one to one.
 */
export function locate(sol: Solution, stored: NapkinNode, prefix = 0, strict = false): Located | null {
	let match: ReturnType<typeof nodeAt>;
	try {
		match = nodeAt(sol.spot, stored.path.slice(prefix));
	} catch (error) {
		if (strict) throw error;
		return null;
	}
	const pairing = strict ? pairActions(match.labels, stored.actions) : pairSubset(match.labels, stored.actions);
	if (!pairing) {
		if (strict) throw new Error(`${stored.id} ${stored.path.join(',')}: ours ${match.labels}, stored ${stored.actions}`);
		return null;
	}
	const dealt = match.dealt.flatMap((c) => parseCards(c));
	const cards = [...sol.spot.board, ...dealt];
	const resolved = sol.spot.resolveBoard(cards, match.node);
	return { node: match.node, board: resolved.board, relabel: resolved.combos, pairing };
}

/** Our average strategy at a located node, as a `Mix` over real combinations. */
function mixOf(sol: Solution, at: Located): Mix {
	const view = sol.strategyAt(at.node, at.board);
	const row = new Int32Array(COMBOS).fill(-1);
	view.combos.forEach((c, i) => (row[c] = i));
	const n = view.actions.length;
	return (a, combo) => {
		const r = row[at.relabel[combo]];
		const edge = at.pairing[a];
		return r < 0 || edge < 0 ? 0 : view.probs[r * n + edge];
	};
}

export function summarise(nodes: readonly NodeScore[]): Summary {
	const mean = (f: (n: NodeScore) => number): number =>
		nodes.length ? nodes.reduce((s, n) => s + f(n), 0) / nodes.length : Number.NaN;
	return { nodes: nodes.length, loss: mean((n) => n.loss), refLoss: mean((n) => n.refLoss), handDiff: mean((n) => n.handDiff) };
}

/**
 * Each player's reach, out of position first, at the end of a stored node's
 * flop line, under the stored strategy: within-street, as `reach` is. Null if
 * a flop decision on the line was not stored, which the export does only
 * for lines a player rarely takes.
 */
const flopBySpot = new Map<string, Map<string, NapkinNode>>();

export function lineReach(stored: NapkinNode): [number, number] | null {
	let flop = flopBySpot.get(stored.spot);
	if (!flop) {
		flop = new Map(napkinNodes('flop').filter((n) => n.spot === stored.spot).map((n) => [n.path.join(','), n]));
		flopBySpot.set(stored.spot, flop);
	}
	const reach: [number, number] = [1, 1];
	const steps = stored.path.slice(0, stored.path.findIndex((s) => s.startsWith('d')));
	for (let i = 0; i < steps.length; i++) {
		const node = flop.get(steps.slice(0, i).join(','));
		if (!node) return null;
		const a = node.actions.indexOf(steps[i]);
		if (a < 0) return null;
		let mass = 0;
		let taken = 0;
		node.weight.forEach((w, j) => {
			mass += w;
			taken += w * node.strategy[a][j];
		});
		reach[node.actor] = node.reach[0] * (taken / mass);
		reach[1 - node.actor] = node.reach[1];
	}
	return reach;
}

/**
 * The stored nodes of a spot that are scored. A flop node needs opponent reach
 * of at least `MIN_REACH`. A turn node's within-street reach is always 1, so
 * there both players' reach at the end of its flop line must be.
 */
export function storedNodes(spot: string, street: 'flop' | 'turn'): NapkinNode[] {
	return napkinNodes(street).filter((n) => {
		if (n.spot !== spot) return false;
		if (street === 'flop') return n.reach[1] >= MIN_REACH;
		const line = lineReach(n);
		return line !== null && Math.min(...line) >= MIN_REACH;
	});
}

/**
 * Score a solution of a napkinpoker spot at every stored node it holds.
 *
 * @param sol a solve of `napkinSpots()`'s config for `spot` (any approximation)
 * @param streets which stored streets to score
 */
export function scoreSolution(sol: Solution, spot: string, streets: readonly ('flop' | 'turn')[] = ['flop', 'turn']): SpotScore {
	const nodes: NodeScore[] = [];
	const missing: string[] = [];
	for (const street of streets) {
		for (const stored of storedNodes(spot, street)) {
			const at = locate(sol, stored);
			if (at) nodes.push(scoreNode(stored, street, mixOf(sol, at), (a) => at.pairing[a] >= 0));
			else missing.push(`${stored.id} ${stored.path.join(',')}`);
		}
	}
	const at = (path: string): NodeScore | null => nodes.find((n) => n.street === 'flop' && n.path === path) ?? null;
	return {
		spot,
		nodes,
		missing,
		root: { oop: at(''), ip: at('X') },
		flop: summarise(nodes.filter((n) => n.street === 'flop')),
		turn: summarise(nodes.filter((n) => n.street === 'turn')),
	};
}

/**
 * Score a re-solved turn (`resolveSubgame(...).solution`) at the stored turn
 * node it starts at: its root is that node, on the flop plus the turn card.
 *
 * @param relabel real combination → combination on the subgame's board, as
 *   the blueprint's `resolveBoard` gave it for that turn (`Located.relabel`)
 */
export function scoreSubgame(sub: Solution, stored: NapkinNode, relabel?: Uint16Array): NodeScore | null {
	const own = locate(sub, stored, stored.path.length);
	if (!own) return null;
	// The subgame is dealt on the blueprint's stored board, which with
	// buckets or mirrored runouts can differ from the real one.
	const at = relabel ? { ...own, relabel: Uint16Array.from(relabel, (c) => own.relabel[c]) } : own;
	return scoreNode(stored, 'turn', mixOf(sub, at), (a) => at.pairing[a] >= 0);
}

/** One node's regrets, ours against the stored solver's. */
export interface RegretCheck {
	readonly id: string;
	readonly path: string;
	readonly street: 'flop' | 'turn';
	readonly reach: readonly [number, number];
	/**
	 * Per hand and action, |(EV(a) − EV(best)) ours − the same stored|,
	 * reach-weighted mean over hands, averaged over actions; % of the node's pot.
	 */
	readonly meanError: number;
	/** The largest such error for a hand holding at least `WELL_HELD` of the node's reach. */
	readonly maxError: number;
	/**
	 * The same error on the actions each hand plays: per hand, each action's
	 * error weighted by the larger of our and the stored probability of it.
	 * Unplayed actions' values are off-path, which neither solve trains
	 * closely, so this is the error that matters to play.
	 */
	readonly playedError: number;
	/** Our own play's loss at our values (self-regret), for scale. */
	readonly selfLoss: number;
	/**
	 * Per stored action: its mean regret error as above, and how often we and
	 * the stored solver play it (reach-weighted). Errors at actions neither
	 * plays are off-path values, which neither solve trains closely.
	 */
	readonly byAction: readonly { readonly action: string; readonly meanError: number; readonly ours: number; readonly stored: number }[];
}

/**
 * Compare our per-action EVs at each stored node against the stored ones,
 * regret against regret (never absolute levels). Our EVs are taken under our
 * own ranges at the node, as the stored ones are under the stored solver's.
 */
export function crossCheck(sol: Solution, spot: string, streets: readonly ('flop' | 'turn')[] = ['flop', 'turn']): RegretCheck[] {
	const out: RegretCheck[] = [];
	const { tree } = sol.spot;
	for (const street of streets) {
		for (const stored of storedNodes(spot, street)) {
			const at = locate(sol, stored, 0, true)!;
			const actor = tree.player[at.node] as 0 | 1;
			// reachAt keeps hands a later card blocks; they cannot be dealt here.
			const round = tree.round[at.node];
			const width = sol.spot.runouts.width[round];
			const cards = sol.spot.runouts.cards[round].subarray(at.board * width, at.board * width + width);
			const me = offCards(sol.reachAt(at.node, at.board, actor), cards);
			const opp = offCards(sol.reachAt(at.node, at.board, (1 - actor) as 0 | 1), cards);
			const open = openMass(opp);
			const live: number[] = [];
			for (let h = 0; h < COMBOS; h++) if (me[h] > 0 || opp[h] > 0) live.push(h);
			const liveList = Uint16Array.from(live);
			const evs = stored.actions.map((_, a) =>
				nodeEvs(sol, tree.edgeChild[tree.firstEdge[at.node] + at.pairing[a]], at.board, actor, me, opp, open, liveList),
			);
			const mix = mixOf(sol, at);
			const pct = 100 / stored.pot;
			let mass = 0;
			let err = 0;
			let self = 0;
			let playedErr = 0;
			let worst = 0;
			let total = 0;
			const k = stored.actions.length;
			const actionErr = new Float64Array(k);
			const oursFreq = new Float64Array(k);
			const storedFreq = new Float64Array(k);
			for (let i = 0; i < stored.combos.length; i++) total += stored.weight[i];
			for (let i = 0; i < stored.combos.length; i++) {
				const w = stored.weight[i];
				const h = at.relabel[stored.combos[i]];
				const ours = evs.map((e) => e[h]);
				const theirs = stored.actions.map((_, a) => stored.ev[a][i]);
				if (!(w > 0) || !ours.every(Number.isFinite) || !theirs.every(Number.isFinite)) continue;
				const bestOurs = Math.max(...ours);
				const bestTheirs = Math.max(...theirs);
				let e = 0;
				let played = 0;
				let onPath = 0;
				let onPathWeight = 0;
				for (let a = 0; a < k; a++) {
					const ea = Math.abs(ours[a] - bestOurs - (theirs[a] - bestTheirs));
					e += ea;
					actionErr[a] += w * ea;
					const p = mix(a, stored.combos[i]);
					const q = Math.max(p, stored.strategy[a][i]);
					onPath += q * ea;
					onPathWeight += q;
					played += p * ours[a];
					oursFreq[a] += w * p;
					storedFreq[a] += w * stored.strategy[a][i];
				}
				e /= k;
				mass += w;
				err += w * e;
				self += w * (bestOurs - played);
				playedErr += onPathWeight > 0 ? (w * onPath) / onPathWeight : 0;
				if (w >= WELL_HELD * total) worst = Math.max(worst, e);
			}
			out.push({
				id: stored.id,
				path: stored.path.join(','),
				street,
				reach: stored.reach,
				meanError: (pct * err) / mass,
				maxError: pct * worst,
				playedError: (pct * playedErr) / mass,
				selfLoss: (pct * self) / mass,
				byAction: stored.actions.map((action, a) => ({
					action,
					meanError: (pct * actionErr[a]) / mass,
					ours: oursFreq[a] / mass,
					stored: storedFreq[a] / mass,
				})),
			});
		}
	}
	return out;
}

/**
 * Our EV in chips per combination of `player` from `node` on stored board
 * `board`, conditional on reaching it: values under the average strategy over
 * the opponent's unblocked reach (`open`), per runout. NaN where undefined.
 */
function nodeEvs(
	sol: Solution,
	node: number,
	board: number,
	player: 0 | 1,
	reachMe: Float64Array,
	reachOpp: Float64Array,
	open: Float64Array,
	live: Uint16Array,
): Float64Array {
	const values = sol.solver.valuesAt(node, board, player, reachMe, reachOpp, live, live.length);
	const deals = sol.solver.ctx.runoutWeight[sol.spot.tree.round[node]];
	const out = new Float64Array(COMBOS).fill(Number.NaN);
	for (let h = 0; h < COMBOS; h++) if (reachMe[h] > 0 && open[h] > 0) out[h] = values[h] / (open[h] * deals);
	return out;
}

/** `reach` with every combination holding one of `cards` zeroed. */
export function offCards(reach: Float64Array, cards: ArrayLike<number>): Float64Array {
	const out = reach.slice();
	const used = new Uint8Array(52);
	for (let i = 0; i < cards.length; i++) used[cards[i]] = 1;
	for (let h = 0; h < COMBOS; h++) if (used[COMBO_CARDS[h * 2]] || used[COMBO_CARDS[h * 2 + 1]]) out[h] = 0;
	return out;
}
