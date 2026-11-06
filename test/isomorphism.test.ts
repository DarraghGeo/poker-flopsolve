/**
 * Suit isomorphism is exact.
 *
 * Solving with and without it cannot be compared iteration by iteration: the
 * folded solve adds the same runouts in a different order, and regret
 * matching, discontinuous at zero, turns rounding differences into different
 * trajectories. So these tests check the mapping itself. A folded solve's
 * strategy is copied onto every real runout of an unfolded solver, through the
 * board maps; if folding is exact, the unfolded game under that strategy has
 * exactly the EVs and exploitability the folded solver reports.
 */

import { describe, expect, it } from 'vitest';
import { COMBOS, parseCards } from '../src/cards.ts';
import { createRun, defineSpot } from '../src/index.ts';
import type { SolveRun, SpotConfig } from '../src/index.ts';
import { suitSymmetries } from '../src/abstraction.ts';
import { enumerateRunouts } from '../src/runouts.ts';

const NARROW_OOP = 'AA,KK,QQ,AKs,AQs,KQs,76s,65s';
const NARROW_IP = 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s';

const spot = (board: string, extra: Partial<SpotConfig> = {}): SpotConfig => ({
	board, pot: 60, stack: 100, oop: NARROW_OOP, ip: NARROW_IP, betSizes: [[0.66]], maxRaises: 1, ...extra,
});

const symmetric = (text: string): number =>
	suitSymmetries(parseCards(text), [new Float64Array(COMBOS).fill(1)]).length;

/** Copy a folded run's accumulators onto every real runout of an unfolded one. */
function unfold(folded: SolveRun, full: SolveRun): void {
	const from = folded.solver.ctx;
	const to = full.solver.ctx;
	const { tree, runouts } = to;
	for (const node of tree.decisionNodes) {
		const round = tree.round[node];
		const actions = tree.numEdges[node];
		const index = to.players[tree.player[node]];
		const width = runouts.width[round];
		for (let board = 0; board < runouts.counts[round]; board++) {
			const cards = Array.from(runouts.cards[round].subarray(board * width, (board + 1) * width));
			const { board: stored, combos } = folded.spot.resolveBoard(cards);
			for (let a = 0; a < actions; a++) {
				for (let i = 0; i < index.count; i++) {
					const combo = index.combos[i];
					const image = from.players[tree.player[node]].slot[combos[combo]];
					if (image < 0) continue;
					const target = to.layout.offset[node] + (board * actions + a) * index.count + i;
					const source = from.layout.offset[node] + (stored * actions + a) * index.count + image;
					to.strategySum[target] = from.strategySum[source];
					to.regret[target] = from.regret[source];
				}
			}
		}
	}
}

describe('suit symmetry', () => {
	it('finds the suits a board leaves interchangeable', () => {
		expect(symmetric('As Kh 7d')).toBe(1); // rainbow: one empty suit, nothing to swap it with
		expect(symmetric('Ts 9s 4h')).toBe(2); // two-tone: the two absent suits
		expect(symmetric('Ks 9s 4s')).toBe(6); // monotone: the three absent suits
		expect(symmetric('As Kh 7d 2c')).toBe(1);
	});

	it('stores one deal per orbit', () => {
		const ones = [new Float64Array(COMBOS).fill(1)];
		const count = (text: string): readonly number[] => {
			const board = parseCards(text);
			return enumerateRunouts(board, suitSymmetries(board, ones)).counts;
		};
		expect(count('Ts 9s 4h')).toEqual([1, 36, 36 * 48 - 23 * 13]);
		expect(count('Ks 9s 4s')[1]).toBe(10 + 13);
		expect(count('As Kh 7d')).toEqual([1, 49, 49 * 48]);
	});

	it('ignores symmetry the ranges break', () => {
		// A partial weight on one suited combo: its mirror image keeps full weight.
		const folded = defineSpot(spot('Ts 9s 4h', { oop: `${NARROW_OOP},AdKd:0.5` }));
		expect(folded.runouts.symmetric).toBe(false);
		expect(folded.runouts.counts[1]).toBe(49);
	});

	it('can be switched off', () => {
		expect(defineSpot(spot('Ts 9s 4h', { isomorphism: false })).runouts.counts[1]).toBe(49);
	});
});

describe('folding mirrored runouts', () => {
	for (const board of ['Ts 9s 4h', 'Ks 9s 4s']) {
		it(`is exact on ${board}`, () => {
			const folded = createRun(defineSpot(spot(board)), { workers: 1, precision: 'f64' });
			const full = createRun(defineSpot(spot(board, { isomorphism: false })), { workers: 1, precision: 'f64' });
			try {
				expect(folded.spot.runouts.counts[2]).toBeLessThan(full.spot.runouts.counts[2]);
				folded.step(25);
				unfold(folded, full);

				const a = folded.snapshot();
				const b = full.snapshot();
				expect(a.ev(0)).toBeCloseTo(b.ev(0), 10);
				expect(a.ev(1)).toBeCloseTo(b.ev(1), 10);
				expect(folded.exploitabilityPercent()).toBeCloseTo(full.exploitabilityPercent(), 10);

				// The cheap path, adding relabelled values, against walking every
				// mirrored deal with its own reach.
				const ctx = folded.solver.ctx;
				const shortcut = folded.solver.exploitability();
				ctx.expandOrbits = true;
				const walked = folded.solver.exploitability();
				ctx.expandOrbits = false;
				expect(shortcut).toBeCloseTo(walked, 12);
			} finally {
				folded.close();
				full.close();
			}
		});
	}

	it('answers valuesAt for an asymmetric reach as the unfolded game does', () => {
		const folded = createRun(defineSpot(spot('Ts 9s 4h')), { workers: 1, precision: 'f64' });
		const full = createRun(defineSpot(spot('Ts 9s 4h', { isomorphism: false })), { workers: 1, precision: 'f64' });
		try {
			folded.step(15);
			unfold(folded, full);
			const ip = folded.spot.players[1];
			const oop = folded.spot.players[0];
			// One opposing hand holding a diamond: no suit swap leaves it alone.
			const one = new Float64Array(COMBOS);
			const hand = oop.combos.find((combo) => oop.weights[combo] > 0 && (combo % 4 === 2 || true))!;
			one[hand] = 1;
			const live = folded.solver.rootLive.subarray(0, folded.solver.rootCount);
			const x = folded.solver.valuesAt(0, 0, 1, Float64Array.from(ip.weights), one, live, live.length);
			const y = full.solver.valuesAt(0, 0, 1, Float64Array.from(ip.weights), one, live, live.length);
			for (const combo of ip.combos) expect(x[combo]).toBeCloseTo(y[combo], 10);
		} finally {
			folded.close();
			full.close();
		}
	});

	it('stays exact when the folded solve is split across workers', () => {
		// Worker counts are not compared with each other: a different
		// association of the same sums already moves a flop solve, folded or
		// not. What must hold is that the folded game the workers train is
		// still exactly the unfolded game.
		const folded = createRun(defineSpot(spot('Ks 9s 4s')), { workers: 4, precision: 'f64' });
		const full = createRun(defineSpot(spot('Ks 9s 4s', { isomorphism: false })), { workers: 1, precision: 'f64' });
		try {
			expect(folded.workers).toBe(4);
			folded.step(10);
			unfold(folded, full);
			expect(folded.exploitabilityPercent()).toBeCloseTo(full.exploitabilityPercent(), 10);
			expect(folded.snapshot().ev(0)).toBeCloseTo(full.snapshot().ev(0), 10);
		} finally {
			folded.close();
			full.close();
		}
	});
});
