/**
 * Per-combination root EVs, and the opt-in current-profile estimate (#35).
 *
 * `handEvs` is the range-level `ev` broken down by hand, so its weighted mean
 * has to give `ev` back. The current profile is DCFR's regret-matched
 * strategy, read with no update applied, so reading it must leave the solve
 * exactly where it was, on every engine and thread count.
 */

import { describe, expect, it } from 'vitest';
import { COMBO_CARDS, COMBOS, createRun, defineSpot, parseCards } from '../src/index.ts';
import type { SolveOptions, SpotConfig } from '../src/index.ts';
import { Mode } from '../src/cfr.ts';
import { SPOTS } from '../bench/compare/spots.ts';

const twotone: SpotConfig = {
	board: 'Ts 9s 4h', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};

const CURRENT: SolveOptions = { approximations: { currentProfileEv: true } };

/** Run `iterations` and hand back a snapshot and the run, which the caller closes. */
function stepped(config: SpotConfig, iterations: number, options: SolveOptions = {}) {
	const run = createRun(defineSpot(config), { workers: 1, ...options });
	run.step(iterations);
	return { run, solution: run.snapshot() };
}

/** Mean of per-hand EVs weighted by range weight times compatible opponent mass. */
function weightedMean(config: SpotConfig, evs: Float64Array, player: 0 | 1): number {
	const spot = defineSpot(config);
	const mine = spot.players[player].weights;
	const theirs = spot.players[1 - player].weights;
	let sum = 0;
	let mass = 0;
	for (let combo = 0; combo < COMBOS; combo++) {
		if (mine[combo] === 0) continue;
		let against = 0;
		const a = COMBO_CARDS[combo * 2];
		const b = COMBO_CARDS[combo * 2 + 1];
		for (let other = 0; other < COMBOS; other++) {
			const c = COMBO_CARDS[other * 2];
			const d = COMBO_CARDS[other * 2 + 1];
			if (c !== a && c !== b && d !== a && d !== b) against += theirs[other];
		}
		sum += mine[combo] * against * evs[combo];
		mass += mine[combo] * against;
	}
	return sum / mass;
}

/** Entries that differ between two arrays of the same length. */
function changed(now: ArrayLike<number>, before: Float64Array): number {
	let count = 0;
	for (let i = 0; i < before.length; i++) if (!Object.is(now[i], before[i])) count++;
	return count;
}

describe('handEvs', () => {
	for (const [name, config] of [['river', SPOTS.river], ['turn', SPOTS.turn], ['two-tone flop', twotone]] as const) {
		it(`averages back to ev on the ${name}, under both profiles`, () => {
			for (const options of [{}, CURRENT]) {
				const { run, solution } = stepped(config, 20, options);
				try {
					for (const player of [0, 1] as const) {
						const mean = weightedMean(config, solution.handEvs(player), player);
						expect(mean).toBeCloseTo(solution.ev(player), 9);
					}
				} finally {
					run.close();
				}
			}
		});
	}

	it('is indexed by combination, zero outside the range and on board cards', () => {
		const { run, solution } = stepped(twotone, 20);
		try {
			const board = new Set(parseCards(twotone.board));
			for (const player of [0, 1] as const) {
				const evs = solution.handEvs(player);
				expect(evs.length).toBe(COMBOS);
				const weights = solution.spot.players[player].weights;
				let nonzero = 0;
				for (let combo = 0; combo < COMBOS; combo++) {
					const blocked = board.has(COMBO_CARDS[combo * 2]) || board.has(COMBO_CARDS[combo * 2 + 1]);
					if (weights[combo] === 0 || blocked) expect(evs[combo]).toBe(0);
					else if (evs[combo] !== 0) nonzero++;
				}
				expect(nonzero).toBeGreaterThan(0);
			}
			// AA beats everything IP holds here bar sets, so it wins chips.
			const aces = solution.handEvs(0);
			const spot = solution.spot;
			let best = -Infinity;
			for (const combo of spot.players[0].combos) best = Math.max(best, aces[combo]);
			expect(best).toBeGreaterThan(0);
		} finally {
			run.close();
		}
	});

	it('returns a fresh copy from one cached pass', () => {
		const { run, solution } = stepped(SPOTS.river, 10);
		try {
			const first = solution.handEvs(0);
			first.fill(123);
			expect(solution.handEvs(0)).not.toEqual(first);
			expect(solution.handEvs(0)).toEqual(solution.handEvs(0));
		} finally {
			run.close();
		}
	});
});

describe('currentProfileEv', () => {
	it('leaves ev exactly as it was when unset', () => {
		for (const engine of [undefined, 'js'] as const) {
			const plain = stepped(SPOTS.turn, 25, { engine });
			const off = stepped(SPOTS.turn, 25, { engine, approximations: { currentProfileEv: false } });
			try {
				// The pre-#35 computation, which `ev` used to call directly.
				const reference = plain.run.solver.expectedValue();
				for (const player of [0, 1] as const) {
					expect(plain.solution.ev(player)).toBe(reference[player]);
					expect(off.solution.ev(player)).toBe(reference[player]);
				}
			} finally {
				plain.run.close();
				off.run.close();
			}
		}
	});

	it('reports a different profile from the average, consistent with the regret-matched pass', () => {
		const average = stepped(SPOTS.turn, 15, { engine: 'js', precision: 'f64' });
		const current = stepped(SPOTS.turn, 15, { engine: 'js', precision: 'f64', ...CURRENT });
		try {
			expect(current.solution.ev(0)).not.toBe(average.solution.ev(0));
			// The traversal #27 used: Train with updates off.
			const ctx = average.run.solver.ctx;
			ctx.applyUpdates = false;
			try {
				for (const player of [0, 1] as const) {
					const direct = average.run.solver.traverseRoot(Mode.Train, player, 16);
					const values = current.run.solver.rootValues(Mode.Current).values[player];
					for (let i = 0; i < values.length; i++) expect(values[i]).toBe(direct[i]);
				}
			} finally {
				ctx.applyUpdates = true;
			}
		} finally {
			average.run.close();
			current.run.close();
		}
	});

	// JavaScript on one thread and a pool, the WebAssembly engine on one
	// thread and a pool.
	const ENGINES: readonly [string, SolveOptions][] = [
		['JavaScript', { engine: 'js', precision: 'f64' }],
		['JavaScript pool', { engine: 'js', precision: 'f64', workers: 2 }],
		['WebAssembly', { precision: 'f32' }],
		['WebAssembly pool', { precision: 'f32', workers: 2 }],
		['16-bit', { precision: 'i16' }],
	];

	for (const [name, options] of ENGINES) {
		it(`changes nothing in the solve when read, on ${name}`, () => {
			const read = createRun(defineSpot(SPOTS.turn), { workers: 1, ...options, ...CURRENT });
			const untouched = createRun(defineSpot(SPOTS.turn), { workers: 1, ...options, ...CURRENT });
			try {
				for (const run of [read, untouched]) run.step(10);
				const regret = Float64Array.from(read.solver.ctx.regret);
				const sums = Float64Array.from(read.solver.ctx.strategySum);
				const solution = read.snapshot();
				solution.ev(0);
				solution.handEvs(1);
				// Counted rather than compared whole: a diff of millions of
				// entries would take minutes to print.
				expect(changed(read.solver.ctx.regret, regret)).toBe(0);
				expect(changed(read.solver.ctx.strategySum, sums)).toBe(0);
				// And the solve carries on exactly as one never read.
				for (const run of [read, untouched]) run.step(5);
				expect(read.snapshot().ev(0)).toBe(untouched.snapshot().ev(0));
				expect(read.snapshot().handEvs(1)).toEqual(untouched.snapshot().handEvs(1));
			} finally {
				read.close();
				untouched.close();
			}
		});
	}

	it('agrees across engines and thread counts', () => {
		// One iteration, before regret matching's jump at zero can amplify the
		// engines' different rounding.
		const evsOf = (options: SolveOptions): Float64Array[] => {
			const { run, solution } = stepped(twotone, 1, { ...options, ...CURRENT });
			try {
				return [solution.handEvs(0), solution.handEvs(1)];
			} finally {
				run.close();
			}
		};
		const [reference, ...others] = ENGINES.map(([, options]) => evsOf(options));
		for (const other of others) {
			for (const player of [0, 1]) {
				for (let combo = 0; combo < COMBOS; combo++) {
					expect(other[player][combo]).toBeCloseTo(reference[player][combo], 3);
				}
			}
		}
	});

	it('needs regrets, which an analysis-only run lacks', () => {
		const run = createRun(defineSpot(SPOTS.river), { analysisOnly: true, ...CURRENT });
		try {
			expect(() => run.snapshot().ev(0)).toThrow(/regrets/);
		} finally {
			run.close();
		}
	});
});
