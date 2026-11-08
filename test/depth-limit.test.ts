import { describe, expect, it } from 'vitest';
import { COMBO_CARDS, COMBOS, createRun, defineSpot, evaluateCards, NodeKind, parseCards, solve } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';

const OOP = 'AA,KK,QQ,AK,AQ,KQ,JTs,T9s,98s,65s';
const IP = 'KK,QQ,JJ,TT,AK,AQ,KQs,QJs,JTs,T9s';

describe('depth-limited solving', () => {
	it('is off by default: the tree has no leaves and nothing changes', () => {
		const config: SpotConfig = { board: 'AsKh7d2c', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.5]] };
		const spot = defineSpot(config);
		expect(spot.tree.leafNodes).toBeUndefined();
		expect([...spot.tree.kind].includes(NodeKind.Continuation)).toBe(false);
		expect(createRun(spot).engine).toBe('wasm');
	});

	it('cuts every river node out of a turn tree', () => {
		const config: SpotConfig = { board: 'AsKh7d2c', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.5]] };
		const full = defineSpot(config);
		const limited = defineSpot({ ...config, depthLimit: {} });
		expect([...limited.tree.round].filter((r, node) => r === 1 && limited.tree.kind[node] === NodeKind.Decision)).toEqual([]);
		// Turn decisions stay: check, bet, and the two answers.
		expect(limited.tree.decisionNodes.length).toBe(4);
		expect(full.tree.decisionNodes.length).toBe(4 + 3 * 4);
		expect(limited.tree.leafNodes!.length).toBe(3);
		expect(limited.estimate.totalSlots).toBeLessThan(full.estimate.totalSlots);
	});

	it('with check-down only, equals the same spot with no betting past the cut', () => {
		const base = { board: 'AsKh7d2c', pot: 60, stack: 120, oop: OOP, ip: IP, maxRaises: 1 } as const;
		const full = solve(defineSpot({ ...base, betSizes: [[0.5], []] }), { iterations: 200, engine: 'js', precision: 'f64' });
		const limited = solve(defineSpot({ ...base, betSizes: [[0.5], [0.5]], depthLimit: { continuations: ['checkdown'] } }), {
			iterations: 200,
			precision: 'f64',
		});
		expect(limited.ev(0)).toBeCloseTo(full.ev(0), 9);
		expect(limited.exploitability()).toBeCloseTo(full.exploitability(), 9);
	});

	it('cut at the turn, check-down only, equals a flop spot that checks to showdown', () => {
		const base = { board: 'AsKh7d', pot: 60, stack: 120, oop: 'AA,KK,AK,QJs', ip: 'QQ,JJ,AQ,T9s', maxRaises: 1 } as const;
		const full = solve(defineSpot({ ...base, betSizes: [[0.5], [], []] }), { iterations: 100, engine: 'js', precision: 'f64' });
		const limited = solve(
			defineSpot({ ...base, betSizes: [[0.5]], depthLimit: { at: 'turn', continuations: ['checkdown'] } }),
			{ iterations: 100, precision: 'f64' },
		);
		expect(limited.ev(0)).toBeCloseTo(full.ev(0), 9);
		expect(limited.exploitability()).toBeCloseTo(full.exploitability(), 9);
	});

	it('values a single continuation as playing it out hand against hand on every river', () => {
		// No turn betting: one line, check-check, into one leaf. One
		// continuation leaves nothing to choose, so the value is fixed.
		const pot = 60;
		const config: SpotConfig = {
			board: 'AsKh7d2c', pot, stack: 120, oop: OOP, ip: IP, betSizes: [[]],
			depthLimit: { continuations: ['polar'], betSize: 1 },
		};
		const spot = defineSpot(config);
		const run = createRun(spot, { precision: 'f64' });
		run.step(1);
		const got = run.snapshot().ev(0);

		// The same by brute force. Pot-sized bet B = 60 into P = 60: value at
		// or above the 70th percentile, balanced bluffs below 0.3 * (1/3) /
		// (2/3) = 0.15, calls at or above 1 - P / (P + B) = 0.5.
		const board = parseCards(config.board);
		const weights = spot.players.map((p) => p.weights);
		const half = pot / 2;
		const bet = 60;
		let total = 0;
		let mass = 0;
		for (let river = 0; river < 52; river++) {
			if (board.includes(river)) continue;
			const final = [...board, river];
			const live = (combo: number): boolean =>
				!final.includes(COMBO_CARDS[combo * 2]) && !final.includes(COMBO_CARDS[combo * 2 + 1]);
			const strength = new Float64Array(COMBOS);
			for (let combo = 0; combo < COMBOS; combo++) {
				if (live(combo)) strength[combo] = evaluateCards([...final, COMBO_CARDS[combo * 2], COMBO_CARDS[combo * 2 + 1]]);
			}
			const percentile = weights.map((w) => {
				const q = new Float64Array(COMBOS);
				let sum = 0;
				for (let combo = 0; combo < COMBOS; combo++) if (w[combo] > 0 && live(combo)) sum += w[combo];
				for (let combo = 0; combo < COMBOS; combo++) {
					if (!(w[combo] > 0 && live(combo))) continue;
					let below = 0;
					let tied = 0;
					for (let other = 0; other < COMBOS; other++) {
						if (!(w[other] > 0 && live(other))) continue;
						if (strength[other] < strength[combo]) below += w[other];
						else if (strength[other] === strength[combo]) tied += w[other];
					}
					q[combo] = (below + tied / 2) / sum;
				}
				return q;
			});
			const bets = (q: number): boolean => q >= 0.7 || q < 0.15;
			const calls = (q: number): boolean => q >= 0.5;
			for (let a = 0; a < COMBOS; a++) {
				if (!(weights[0][a] > 0 && live(a))) continue;
				for (let b = 0; b < COMBOS; b++) {
					if (!(weights[1][b] > 0 && live(b))) continue;
					const cards = new Set([COMBO_CARDS[a * 2], COMBO_CARDS[a * 2 + 1], COMBO_CARDS[b * 2], COMBO_CARDS[b * 2 + 1]]);
					if (cards.size < 4) continue;
					const sign = Math.sign(strength[a] - strength[b]);
					const q0 = percentile[0][a];
					const q1 = percentile[1][b];
					let payoff: number;
					if (bets(q0)) payoff = calls(q1) ? sign * (half + bet) : half;
					else if (bets(q1)) payoff = calls(q0) ? sign * (half + bet) : -half;
					else payoff = sign * half;
					const w = weights[0][a] * weights[1][b];
					total += w * payoff;
					mass += w;
				}
			}
		}
		expect(got).toBeCloseTo(total / mass, 9);
	});

	it('trains the continuation choice like any decision', () => {
		const config: SpotConfig = {
			board: 'AsKh7d2c', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.5]],
			depthLimit: { continuations: ['checkdown', 'polar'] },
		};
		const run = createRun(defineSpot(config));
		run.step(10);
		const early = run.exploitabilityPercent();
		run.step(190);
		expect(run.exploitabilityPercent()).toBeLessThan(early);
		expect(run.exploitabilityPercent()).toBeLessThan(0.1);
		expect(run.engine).toBe('js');
	});

	it('refuses what it cannot do', () => {
		const river: SpotConfig = { board: 'AsKh7d2c9h', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.5]], depthLimit: {} };
		expect(() => defineSpot(river)).toThrow(/later street/);
		const turn: SpotConfig = { ...river, board: 'AsKh7d2c', depthLimit: { at: 'turn' } };
		expect(() => defineSpot(turn)).toThrow(/later street/);
		const fine = defineSpot({ ...river, board: 'AsKh7d2c' });
		expect(() => createRun(fine, { precision: 'i16' })).toThrow(/32- or 64-bit/);
		expect(() => defineSpot({ ...river, board: 'AsKh7d2c', depthLimit: { continuations: ['nope' as never] } })).toThrow(/Unknown continuation/);
	});
});
