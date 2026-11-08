/**
 * Shared pieces of the turn-leaf experiment (issue #22): per-hand equity on a
 * turn board, the hand classes an analytic leaf model is fitted over, range
 * sampling around archetypes, and per-hand root EV out of a solve.
 *
 * Experiment code only; nothing in `src/` imports it.
 */

import { COMBO_CARDS, COMBOS, DECK, categoryOf, evaluateCards, parseCards, parseRange, rankOf, suitOf } from '../../src/index.ts';
import type { SolveRun } from '../../src/index.ts';

/** Range archetypes the training spots are sampled around. */
export const ARCHETYPES: Record<string, string> = {
	benchOop: 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo',
	benchIp: 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo',
	wideOop: '22+,A2s+,K9s+,QTs+,JTs,T9s,98s,AJo+,KQo',
	wideIp: '22+,A8s+,KTs+,QTs+,JTs,T9s,ATo+,KJo+',
	broadway: '22+,ATs+,KTs+,QTs+,JTs,ATo+,KTo+,QTo+,JTo',
	connectors: '55+,A2s+,K9s+,T9s,98s,87s,76s,65s,54s,AJo+,KQo',
};

/** Small seeded generator, so runs reproduce. */
export function rng(seed: number): () => number {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 4294967296;
	};
}

const disjoint = (a: number, b: number): boolean => {
	const a0 = COMBO_CARDS[a * 2], a1 = COMBO_CARDS[a * 2 + 1];
	const b0 = COMBO_CARDS[b * 2], b1 = COMBO_CARDS[b * 2 + 1];
	return a0 !== b0 && a0 !== b1 && a1 !== b0 && a1 !== b1;
};

const blocked = (combo: number, cards: ReadonlySet<number>): boolean =>
	cards.has(COMBO_CARDS[combo * 2]) || cards.has(COMBO_CARDS[combo * 2 + 1]);

/** Combos with weight that the board leaves live. */
export function liveCombos(weights: Float64Array, board: readonly number[]): number[] {
	const dead = new Set(board);
	const out: number[] = [];
	for (let c = 0; c < COMBOS; c++) if (weights[c] > 0 && !blocked(c, dead)) out.push(c);
	return out;
}

/**
 * Each combo's opponent mass (disjoint opposing weight) and its showdown
 * equity against the opposing range over every river card, on a 4-card board.
 */
export function turnEquity(
	board: readonly number[],
	mine: Float64Array,
	opp: Float64Array,
): { equity: Float64Array; mass: Float64Array } {
	const dead = new Set(board);
	const me = liveCombos(mine, board);
	const them = liveCombos(opp, board);
	const win = new Float64Array(COMBOS);
	const total = new Float64Array(COMBOS);
	const mass = new Float64Array(COMBOS);
	for (const a of me) for (const b of them) if (disjoint(a, b)) mass[a] += opp[b];
	const strength = new Int32Array(COMBOS);
	const cards = [...board, 0, 0, 0];
	for (let river = 0; river < DECK; river++) {
		if (dead.has(river)) continue;
		cards[4] = river;
		const evalCombo = (c: number): void => {
			cards[5] = COMBO_CARDS[c * 2];
			cards[6] = COMBO_CARDS[c * 2 + 1];
			strength[c] = evaluateCards(cards);
		};
		for (const c of me) evalCombo(c);
		for (const c of them) evalCombo(c);
		for (const a of me) {
			if (COMBO_CARDS[a * 2] === river || COMBO_CARDS[a * 2 + 1] === river) continue;
			const sa = strength[a];
			for (const b of them) {
				if (COMBO_CARDS[b * 2] === river || COMBO_CARDS[b * 2 + 1] === river || !disjoint(a, b)) continue;
				const w = opp[b];
				total[a] += w;
				const sb = strength[b];
				win[a] += sa > sb ? w : sa === sb ? w / 2 : 0;
			}
		}
	}
	const equity = new Float64Array(COMBOS).fill(Number.NaN);
	for (const a of me) if (total[a] > 0) equity[a] = win[a] / total[a];
	return { equity, mass };
}

/**
 * Hand features on a 4-card board. `cls3` is the issue's made / draw / air;
 * `cls6` splits made hands by strength and draws by outs.
 */
export interface HandFeatures {
	readonly cls3: number;
	readonly cls6: number;
	readonly outs: number;
}

export const CLS3 = ['made', 'draw', 'air'] as const;
export const CLS6 = ['strong', 'medium', 'weak', 'bigDraw', 'smallDraw', 'air'] as const;

export function features(combo: number, board: readonly number[]): HandFeatures {
	const h0 = COMBO_CARDS[combo * 2], h1 = COMBO_CARDS[combo * 2 + 1];
	// Distinct board ranks, highest first.
	const ranks = [...new Set(board.map(rankOf))].sort((a, b) => b - a);
	const r0 = rankOf(h0), r1 = rankOf(h1);
	const cat = categoryOf(evaluateCards([...board, h0, h1]));
	const pocket = r0 === r1;
	const hit0 = ranks.indexOf(r0), hit1 = ranks.indexOf(r1);
	const hits = (hit0 >= 0 ? 1 : 0) + (hit1 >= 0 ? 1 : 0);
	// A flush or straight the hole cards take part in: the board alone has four
	// cards, so any five-card hand of six cards uses at least one hole card.
	const bigMade = cat >= 4;

	let made = -1; // 0 strong, 1 medium, 2 weak
	if (bigMade || (cat >= 3 && (pocket || hits > 0))) made = 0;
	else if (pocket) made = r0 > ranks[0] ? 0 : r0 > (ranks[1] ?? -1) ? 1 : 2;
	else if (hits === 2) made = 0;
	else if (hits === 1) {
		const at = hit0 >= 0 ? hit0 : hit1;
		made = at === 0 ? 0 : at === 1 ? 1 : 2;
	}

	// River cards that make a straight or better, for hands short of one.
	let outs = 0;
	if (cat < 4) {
		const dead = new Set([...board, h0, h1]);
		for (let river = 0; river < DECK; river++) {
			if (dead.has(river)) continue;
			if (categoryOf(evaluateCards([...board, h0, h1, river])) >= 4) outs++;
		}
	}

	const cls6 = made >= 0 ? made : outs >= 8 ? 3 : outs >= 4 ? 4 : 5;
	const cls3 = cls6 <= 2 ? 0 : cls6 <= 4 ? 1 : 2;
	return { cls3, cls6, outs };
}

/**
 * A range sampled around an archetype, as one weight per combination: kept
 * as it is, reweighted at random by hand class, or shaped by equity against
 * `against` into the kinds of range a flop action leaves: top-heavy (a
 * bettor or raiser), polar, condensed (a caller) or capped (a checker).
 */
export function sampleRange(
	next: () => number,
	base: Float64Array,
	board: readonly number[],
	against: Float64Array,
): { weights: Float64Array; mode: string } {
	const weights = Float64Array.from(base);
	const modes = ['full', 'random', 'top', 'polar', 'condensed', 'capped'] as const;
	const mode = modes[Math.floor(next() * modes.length)];
	if (mode === 'full') return { weights, mode };
	if (mode === 'random') {
		// One factor per 169-class, so suits stay alike as real ranges do.
		const factor = new Map<string, number>();
		for (let c = 0; c < COMBOS; c++) {
			if (weights[c] === 0) continue;
			const a = COMBO_CARDS[c * 2], b = COMBO_CARDS[c * 2 + 1];
			const key = `${Math.max(rankOf(a), rankOf(b))}${Math.min(rankOf(a), rankOf(b))}${suitOf(a) === suitOf(b) ? 's' : 'o'}`;
			if (!factor.has(key)) factor.set(key, next() < 0.2 ? 0 : next());
			weights[c] *= factor.get(key)!;
		}
		return { weights, mode };
	}
	const { equity } = turnEquity(board, base, against);
	const live = liveCombos(base, board).filter((c) => !Number.isNaN(equity[c]));
	live.sort((a, b) => equity[b] - equity[a]);
	const n = live.length;
	const low = 0.05 + 0.25 * next();
	const keep = (from: number, to: number): void => {
		for (let i = Math.floor(from * n); i < Math.floor(to * n); i++) weights[live[i]] = base[live[i]];
	};
	for (const c of live) weights[c] = base[c] * low * next();
	if (mode === 'top') keep(0, 0.3 + 0.5 * next());
	else if (mode === 'polar') {
		keep(0, 0.15 + 0.25 * next());
		keep(1 - (0.1 + 0.25 * next()), 1);
	} else if (mode === 'condensed') keep(0.1 + 0.2 * next(), 0.6 + 0.3 * next());
	else keep(0.05 + 0.2 * next(), 1);
	return { weights, mode };
}

export const parse = (notation: string): Float64Array => parseRange(notation);
export const cards = (text: string): number[] => parseCards(text);

/**
 * Per-combo EV at a node under the run's average strategy, in chips relative
 * to an even split of the pot there, with each combo's opponent mass: the
 * counterfactual value divided by the opposing weight it meets.
 */
export function comboEv(
	run: SolveRun,
	node: number,
	board: number,
	player: 0 | 1,
	reachMe: Float64Array,
	reachOpp: Float64Array,
	boardCards: readonly number[],
): { ev: Float64Array; mass: Float64Array } {
	const s = run.solver;
	const live = s.rootLive.subarray(0, s.rootCount);
	const values = s.valuesAt(node, board, player, reachMe, reachOpp, live, live.length);
	const round = s.ctx.tree.round[node];
	const ev = new Float64Array(COMBOS).fill(Number.NaN);
	const mass = new Float64Array(COMBOS);
	const dead = new Set(boardCards);
	const mine = liveCombos(reachMe, boardCards);
	const theirs = liveCombos(reachOpp, boardCards);
	void dead;
	for (const a of mine) {
		let m = 0;
		for (const b of theirs) if (disjoint(a, b)) m += reachOpp[b];
		mass[a] = m;
		if (m > 0) ev[a] = values[a] / (m * s.ctx.runoutWeight[round]);
	}
	return { ev, mass };
}

/** One combo's record in the dataset. */
export interface Row {
	readonly spot: number;
	readonly player: 0 | 1;
	readonly pot: number;
	readonly stack: number;
	readonly combo: number;
	/** Own range weight. */
	readonly w: number;
	/** Opposing mass it meets; `w * m` is its share of the range. */
	readonly m: number;
	readonly eq: number;
	readonly cls3: number;
	readonly cls6: number;
	readonly outs: number;
	/** Range equity of the player, as a feature of the public state. */
	readonly rangeEq: number;
	/** Root EV in chips, relative to an even split of the pot. */
	readonly ev: number;
}

/** Rows for both players of a turn-board leaf with given reaches and true EVs. */
export function rowsFor(
	spot: number,
	board: readonly number[],
	pot: number,
	stack: number,
	reach: readonly [Float64Array, Float64Array],
	ev: readonly [Float64Array, Float64Array],
): Row[] {
	const rows: Row[] = [];
	for (const player of [0, 1] as const) {
		const { equity, mass } = turnEquity(board, reach[player], reach[1 - player]);
		let num = 0, den = 0;
		for (let c = 0; c < COMBOS; c++) {
			if (!(mass[c] > 0) || Number.isNaN(equity[c])) continue;
			num += reach[player][c] * mass[c] * equity[c];
			den += reach[player][c] * mass[c];
		}
		const rangeEq = num / den;
		for (let c = 0; c < COMBOS; c++) {
			if (!(mass[c] > 0) || Number.isNaN(equity[c]) || Number.isNaN(ev[player][c])) continue;
			const f = features(c, board);
			rows.push({
				spot, player, pot, stack, combo: c, w: reach[player][c], m: mass[c], eq: equity[c],
				cls3: f.cls3, cls6: f.cls6, outs: f.outs, rangeEq, ev: ev[player][c],
			});
		}
	}
	return rows;
}
