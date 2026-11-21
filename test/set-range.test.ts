/**
 * `SolveRun.setRange`: changing a range in place on a live run, and the
 * reserve that keeps storage for hands a range may gain.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, parseRange, RANGE_RESUME } from '../src/index.ts';
import type { SolveOptions, SolveRun, SpotConfig } from '../src/index.ts';
import { comboIndex, parseCards } from '../src/cards.ts';
import { warmStart } from '../src/warm.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const WIDE = `${OOP},K8s-K6s,Q8s,J8s,T8s,76s,65s,A9o-A8o,QJo`;
const TIGHT = 'AA-55,AKs-A7s,KQs-KTs,QJs-QTs,JTs,T9s,AKo-AJo,KQo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const river: SpotConfig = { board: 'AsKh7d2c9h', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.33, 0.75]], maxRaises: 2, allowAllIn: true };
const flop: SpotConfig = {
	board: 'Ts9s4h', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};
const ONE: SolveOptions = { workers: 1, precision: 'f64' };

const combo = (hand: string): number => {
	const [a, b] = parseCards(hand);
	return comboIndex(a, b);
};

/** Iterations until exploitability is at or under `target`, checked every few. */
function iterationsTo(run: SolveRun, target: number, cap = 400): number {
	const start = run.completed;
	while (run.completed - start < cap) {
		run.step(5);
		if (run.exploitabilityPercent() <= target) return run.completed - start;
	}
	return Infinity;
}

describe('a reserve', () => {
	it('stores hands the range does not hold, off the board', () => {
		const spot = defineSpot({ ...river, oopReserve: WIDE });
		const plain = defineSpot({ ...river, oop: WIDE });
		expect(Array.from(spot.players[0].combos)).toEqual(Array.from(plain.players[0].combos));
		expect(spot.players[0].weights[combo('7h6h')]).toBe(0);
		expect(spot.players[0].slot[combo('7h6h')]).toBeGreaterThanOrEqual(0);
		expect(spot.players[0].slot[combo('7d6d')]).toBe(-1);
	});

	it('leaves the game what it was', () => {
		const reserved = createRun(defineSpot({ ...river, oopReserve: WIDE, ipReserve: `${IP},65s` }), ONE);
		const plain = createRun(defineSpot(river), ONE);
		try {
			reserved.step(60);
			plain.step(60);
			expect(reserved.exploitabilityPercent()).toBeCloseTo(plain.exploitabilityPercent(), 9);
			const a = reserved.snapshot();
			const b = plain.snapshot();
			expect(a.ev(0)).toBeCloseTo(b.ev(0), 9);
			expect(a.ev(1)).toBeCloseTo(b.ev(1), 9);
			for (const view of a.strategyAt(0, 0).probs) expect(Number.isFinite(view)).toBe(true);
		} finally {
			reserved.close();
			plain.close();
		}
	});

	it('keeps only the symmetries that hold for the reserve too', () => {
		const symmetric = defineSpot(flop);
		const lopsided = defineSpot({ ...flop, oopReserve: 'AdKc' });
		expect(lopsided.runouts.counts[2]).toBeGreaterThan(symmetric.runouts.counts[2]);
	});

	it('counts toward maxCombos', () => {
		const held = defineSpot(river).players[0].count;
		expect(() => defineSpot({ ...river, oopReserve: WIDE, maxCombos: held })).toThrow(/reserve/);
	});
});

describe('setRange', () => {
	it.each([
		['adds reserved hands', WIDE],
		['drops hands', TIGHT],
		['reweights hands', `${OOP},AKo:0.5,KQs:0.25`],
	])('%s exactly as a run of the new spot holding the same storage', (_, next) => {
		for (const base of [river, { ...river, board: 'AsKh7d2c', maxRaises: 1 }]) {
			const config = { ...base, oopReserve: WIDE };
			const run = createRun(defineSpot(config), ONE);
			const other = createRun(defineSpot({ ...config, oop: next }), ONE);
			try {
				run.step(30);
				run.setRange(0, next);
				warmStart(other.solver.ctx, run.solver.ctx, true);
				expect(Object.is(run.exploitabilityPercent(), other.exploitabilityPercent())).toBe(true);
				expect(Object.is(run.snapshot().ev(0), other.snapshot().ev(0))).toBe(true);
				expect(Array.from(run.spot.players[0].weights)).toEqual(Array.from(other.spot.players[0].weights));
			} finally {
				run.close();
				other.close();
			}
		}
	});

	it('takes weights as it takes a string, for either player', () => {
		const a = createRun(defineSpot(river), ONE);
		const b = createRun(defineSpot(river), ONE);
		try {
			a.setRange(1, 'TT-22,AQs-A2s,KQs');
			b.setRange(1, parseRange('TT-22,AQs-A2s,KQs'));
			a.step(10);
			b.step(10);
			expect(Object.is(a.exploitabilityPercent(), b.exploitabilityPercent())).toBe(true);
			expect(a.spot.players[1].weights[combo('8c8d')]).toBe(1);
			expect(a.spot.players[1].weights[combo('7c7h')]).toBe(1);
			// Board cards are dropped, as defineSpot drops them.
			expect(a.spot.players[1].weights[combo('7d7h')]).toBe(0);
			expect(a.spot.players[1].weights[combo('QhJh')]).toBe(0);
		} finally {
			a.close();
			b.close();
		}
	});

	it.each([
		['one thread, 64-bit', ONE],
		['the default engine', {}],
		['two threads', { workers: 2 }],
		['16-bit storage', { workers: 1, precision: 'i16' }],
	] as const)('solves the new range in fewer iterations than from scratch: %s', (_, options) => {
		for (const next of [WIDE, TIGHT]) {
			const run = createRun(defineSpot({ ...river, oopReserve: WIDE }), options);
			const cold = createRun(defineSpot({ ...river, oop: next }), options);
			try {
				iterationsTo(run, 0.3);
				run.setRange(0, next);
				expect(run.totalIterations).toBe(RANGE_RESUME);
				const warm = iterationsTo(run, 0.3);
				expect(warm).toBeLessThan(iterationsTo(cold, 0.3));
				// The same game: its value is the cold solve's, to what both are solved to.
				run.step(100);
				cold.step(100);
				const pot = 60;
				expect(Math.abs(run.snapshot().ev(0) - cold.snapshot().ev(0)) / pot).toBeLessThan(0.003);
			} finally {
				run.close();
				cold.close();
			}
		}
	});

	it('keeps runout buckets, which were chosen by the hands stored', () => {
		const config: SpotConfig = { ...flop, runoutBuckets: 3, oopReserve: `${flop.oop as string},JJ,87s` };
		const next = 'AA,KK,AKs,AQs,76s,87s';
		const run = createRun(defineSpot(config), ONE);
		const other = createRun(defineSpot({ ...config, oop: next }), ONE);
		try {
			expect(run.spot.runouts.approximate).toBe(true);
			expect(Array.from(other.spot.runouts.counts)).toEqual(Array.from(run.spot.runouts.counts));
			run.step(20);
			run.setRange(0, next);
			warmStart(other.solver.ctx, run.solver.ctx, true);
			expect(Object.is(run.exploitabilityPercent(), other.exploitabilityPercent())).toBe(true);
			// A spot defined from the changed source stores what this one does.
			const again = defineSpot(run.spot.source);
			expect(Array.from(again.runouts.counts)).toEqual(Array.from(run.spot.runouts.counts));
			expect(Array.from(again.players[0].combos)).toEqual(Array.from(run.spot.players[0].combos));
		} finally {
			run.close();
			other.close();
		}
	});

	it('resumes the count where asked', () => {
		const run = createRun(defineSpot(river), ONE);
		try {
			run.step(50);
			run.setRange(0, TIGHT, { resume: 30 });
			expect(run.totalIterations).toBe(30);
			run.setRange(0, OOP, { resume: 100 });
			expect(run.totalIterations).toBe(30);
			expect(() => run.setRange(0, TIGHT, { resume: -1 })).toThrow(/resume/);
			expect(() => run.setRange(0, TIGHT, { resume: 2.5 })).toThrow(/resume/);
			expect(run.totalIterations).toBe(30);
		} finally {
			run.close();
		}
	});

	it('follows a slider back and forth', () => {
		const run = createRun(defineSpot({ ...river, oopReserve: WIDE }), ONE);
		try {
			for (const next of [WIDE, TIGHT, OOP, WIDE]) {
				run.setRange(0, next);
				expect(iterationsTo(run, 0.5)).toBeLessThan(100);
			}
		} finally {
			run.close();
		}
	});

	it('keeps a low iteration count where it is', () => {
		const run = createRun(defineSpot(river), ONE);
		try {
			run.step(4);
			run.setRange(0, TIGHT);
			expect(run.totalIterations).toBe(4);
			expect(run.completed).toBe(4);
			run.step(20);
			run.setRange(0, OOP);
			expect(run.totalIterations).toBe(RANGE_RESUME);
			expect(run.completed).toBe(24);
		} finally {
			run.close();
		}
	});

	it('shows the new range in the spot and its source', () => {
		const first = createRun(defineSpot(river), ONE);
		try {
			first.setRange(0, TIGHT);
			expect(Array.from(first.spot.source.oop as Float64Array)).toEqual(Array.from(defineSpot({ ...river, oop: TIGHT }).players[0].weights));
			// A warm start from it is no longer a resume of the same spot.
			const next = createRun(defineSpot(river), { ...ONE, warmStart: first });
			expect(next.warmStart?.averages).toBe(false);
			next.close();
		} finally {
			first.close();
		}
	});

	it('leaves the spot fit for another run, threads and all', () => {
		// Its first range differs between suits, so nothing is folded; the new one does not.
		const spot = defineSpot({ ...flop, oop: `${flop.oop},AdKc` });
		const first = createRun(spot, ONE);
		first.setRange(0, 'AA,KK,AKs,76s');
		first.close();
		expect(Array.from(defineSpot(spot.source).players[0].combos)).toEqual(Array.from(spot.players[0].combos));
		const single = createRun(spot, { ...ONE, engine: 'js' });
		const threaded = createRun(spot, { workers: 2, precision: 'f64', engine: 'js' });
		try {
			single.step(10);
			threaded.step(10);
			expect(threaded.workers).toBe(2);
			expect(threaded.exploitabilityPercent()).toBeCloseTo(single.exploitabilityPercent(), 9);
		} finally {
			single.close();
			threaded.close();
		}
	});

	it('keeps solving shared histories on the JavaScript pool', () => {
		// Threads update shared blocks in their own order, so they follow one thread closely, not bit for bit.
		const config: SpotConfig = { ...river, board: 'AsKh7d2c', maxRaises: 1, shareHistories: true };
		const single = createRun(defineSpot(config), { ...ONE, engine: 'js' });
		const threaded = createRun(defineSpot(config), { workers: 2, precision: 'f64', engine: 'js' });
		try {
			for (const run of [single, threaded]) {
				run.step(25);
				run.setRange(0, TIGHT);
				run.step(25);
			}
			expect(threaded.workers).toBe(2);
			expect(Math.abs(threaded.exploitabilityPercent() - single.exploitabilityPercent())).toBeLessThan(0.1);
		} finally {
			single.close();
			threaded.close();
		}
	});

	it('works with shared histories and with chance sampling', () => {
		const turn: SpotConfig = { ...river, board: 'AsKh7d2c', maxRaises: 1 };
		for (const [config, options] of [
			[{ ...turn, shareHistories: true }, ONE],
			[turn, { workers: 1, approximations: { chanceSampling: { probability: 0.5 } } }],
		] as [SpotConfig, SolveOptions][]) {
			const run = createRun(defineSpot(config), options);
			try {
				run.step(40);
				run.setRange(0, TIGHT);
				run.step(60);
				expect(run.exploitabilityPercent()).toBeLessThan(1.5);
			} finally {
				run.close();
			}
		}
	});

	it('refuses what it cannot do in place, and changes nothing', () => {
		const run = createRun(defineSpot(river), ONE);
		const symmetric = createRun(defineSpot(flop), ONE);
		try {
			run.step(10);
			const before = run.exploitabilityPercent();
			const weights = Array.from(run.spot.players[0].weights);
			expect(() => run.setRange(0, WIDE)).toThrow(/has no storage.*oopReserve/);
			expect(() => run.setRange(1, `${IP},65s`)).toThrow(/ipReserve/);
			expect(() => run.setRange(0, '7d7h')).toThrow(/empty/);
			expect(() => run.setRange(0, new Float64Array(10))).toThrow(/10 weights/);
			expect(() => run.setRange(0, parseRange(OOP).fill(-1, 0, 1))).toThrow(/zero or more/);
			expect(Array.from(run.spot.players[0].weights)).toEqual(weights);
			expect(run.totalIterations).toBe(10);
			run.setRange(1, IP);
			expect(run.exploitabilityPercent()).toBe(before);

			expect(() => symmetric.setRange(0, 'AA,KK,QQ,AKs,AQs,KQs,76s,6d5d')).toThrow(/symmetry/);
			symmetric.setRange(0, 'AA,KK,AKs,AQs,76s');

			// Nothing to play once both players hold only the very same hand.
			run.setRange(0, 'TdTc');
			expect(() => run.setRange(1, 'TdTc')).toThrow(/held against/);
		} finally {
			run.close();
			symmetric.close();
		}
	});
});
