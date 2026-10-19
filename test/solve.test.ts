import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, formatCombo, solve, SpotTooLargeError } from '../src/index.ts';

/**
 * The clairvoyance game, with real cards.
 *
 * On a dry board, one player holds only the nuts and pure air, the other only
 * identical bluffcatchers. Its equilibrium is closed form, which makes this the
 * one test here that checks against a known answer rather than against itself.
 *
 * Facing a bet of `f` times the pot the caller defends `1 / (1 + f)`, and the
 * bettor's betting range is `f / (1 + 2f)` bluffs — the frequencies that leave
 * the opponent indifferent.
 */
function clairvoyance(fraction: number) {
	const pot = 100;
	const bet = pot * fraction;
	return defineSpot({
		// 2c 7d 9h Js 3c: no flush, no straight. JJ is trips, TT a bare pair,
		// and 54 misses everything — a strict three-level ladder.
		board: '2c7d9hJs3c',
		pot,
		// Stack equals the bet, so betting is all-in and nobody can raise.
		stack: bet,
		oop: 'JJ,54s',
		ip: 'TT',
		betSizes: [[fraction]],
		maxRaises: 1,
	});
}

/** Betting frequency of each combination at the opening node. */
function openingBets(spot: ReturnType<typeof defineSpot>, sol: ReturnType<typeof solve>) {
	const view = sol.strategyAt(spot.tree.decisionNodes[0], 0);
	const betIndex = view.actions.findIndex((a) => a !== 'check');
	const bets = new Map<string, number>();
	for (let i = 0; i < view.combos.length; i++) {
		bets.set(formatCombo(view.combos[i]), view.probs[i * view.actions.length + betIndex]);
	}
	return bets;
}

describe('the clairvoyance game', () => {
	it.each([0.5, 0.75, 1])('at %s pot, matches the closed form', (fraction) => {
		const spot = clairvoyance(fraction);
		const sol = solve(spot, { iterations: 4000 });

		// Measured against the pot, the only unit comparable across bet sizes.
		expect(sol.exploitabilityPercent()).toBeLessThan(0.01);
		expect(sol.ev(0) + sol.ev(1)).toBeCloseTo(0, 9);

		// The caller defends exactly often enough to make bluffing break even.
		const facingBet = spot.tree.decisionNodes.find((n) => sol.path(n).startsWith('allin') || sol.path(n).startsWith('bet'));
		expect(facingBet).toBeDefined();
		const defence = sol.strategyAt(facingBet!, 0);
		const callIndex = defence.actions.indexOf('call');
		for (let i = 0; i < defence.combos.length; i++) {
			expect(defence.probs[i * defence.actions.length + callIndex]).toBeCloseTo(1 / (1 + fraction), 2);
		}

		// And the bettor bluffs exactly often enough to make calling break even.
		const bets = openingBets(spot, sol);
		let bluffMass = 0;
		let valueMass = 0;
		for (const [combo, frequency] of bets) {
			if (combo.includes('J')) valueMass += frequency;
			else bluffMass += frequency;
		}
		expect(bluffMass / (bluffMass + valueMass)).toBeCloseTo(fraction / (1 + 2 * fraction), 2);

		// Value always bets; air is indifferent and mixes.
		for (const [combo, frequency] of bets) {
			if (combo.includes('J')) expect(frequency).toBeGreaterThan(0.99);
		}
	});

	it('reaches the hand-computed expected value', () => {
		const fraction = 0.75;
		const pot = 100;
		const bet = pot * fraction;
		const defence = 1 / (1 + fraction);

		// Three nut combinations (one jack is on the board) against four air.
		// Air is indifferent, so it is worth exactly the half-pot it forfeits.
		const nuts = (1 - defence) * (pot / 2) + defence * (pot / 2 + bet);
		const expected = (3 / 7) * nuts + (4 / 7) * -(pot / 2);

		const sol = solve(clairvoyance(fraction), { iterations: 6000 });
		expect(sol.ev(0)).toBeCloseTo(expected, 2);
	});

	it('is solved by discounted CFR too', () => {
		const fraction = 0.75;
		const spot = clairvoyance(fraction);
		const sol = solve(spot, { iterations: 4000, algorithm: 'dcfr' });

		expect(sol.exploitabilityPercent()).toBeLessThan(0.01);
		const facingBet = spot.tree.decisionNodes.find((n) => sol.path(n).startsWith('allin') || sol.path(n).startsWith('bet'));
		const defence = sol.strategyAt(facingBet!, 0);
		const callIndex = defence.actions.indexOf('call');
		for (let i = 0; i < defence.combos.length; i++) {
			expect(defence.probs[i * defence.actions.length + callIndex]).toBeCloseTo(1 / (1 + fraction), 2);
		}
	});
});

describe('solver invariants', () => {
	const spot = () =>
		defineSpot({
			board: 'AsKh7d2c',
			pot: 60,
			stack: 120,
			oop: 'AA,KK,QQ,JJ,AQs,KQs,76s',
			ip: 'TT,99,AJs,KJs,QJs,JTs,98s',
			betSizes: [[0.66]],
			maxRaises: 1,
		});

	it('is zero sum and converges', () => {
		const sol = solve(spot(), { iterations: 400, exploitEvery: 100 });
		expect(sol.ev(0) + sol.ev(1)).toBeCloseTo(0, 9);
		expect(sol.exploitabilityPercent()).toBeLessThan(1);
		expect(sol.exploitability()).toBeGreaterThanOrEqual(-1e-12);
		// Exploitability must not climb as iterations accumulate.
		for (let i = 1; i < sol.history.length; i++) {
			expect(sol.history[i].exploitability).toBeLessThanOrEqual(sol.history[i - 1].exploitability + 1e-9);
		}
	});

	it('produces probability distributions everywhere', () => {
		const prepared = spot();
		const sol = solve(prepared, { iterations: 120 });
		for (const node of Array.from(prepared.tree.decisionNodes)) {
			const boards = prepared.runouts.counts[prepared.tree.round[node]];
			const view = sol.strategyAt(node, Math.min(boards - 1, 3));
			for (let i = 0; i < view.combos.length; i++) {
				let sum = 0;
				for (let a = 0; a < view.actions.length; a++) {
					const p = view.probs[i * view.actions.length + a];
					expect(p).toBeGreaterThanOrEqual(-1e-12);
					expect(p).toBeLessThanOrEqual(1 + 1e-9);
					sum += p;
				}
				expect(sum).toBeCloseTo(1, 9);
			}
		}
	});
});

describe('spot validation', () => {
	it('removes board cards from both ranges', () => {
		const spot = defineSpot({
			board: 'AsKhQd',
			pot: 20, stack: 50,
			oop: 'AA', ip: 'KK',
			betSizes: [[0.5]],
		});
		// One ace and one king are on the board, so three of each remain.
		expect(spot.players[0].count).toBe(3);
		expect(spot.players[1].count).toBe(3);
	});

	it('refuses a range emptied by the board', () => {
		expect(() =>
			defineSpot({ board: 'AsAhAd', pot: 20, stack: 50, oop: 'AsAh', ip: 'KK', betSizes: [[0.5]] }),
		).toThrow(/empty once the board is removed/);
	});

	it('honours the combination cap', () => {
		expect(() =>
			defineSpot({
				board: 'AsKh7d', pot: 20, stack: 50,
				oop: 'random', ip: 'KK', betSizes: [[0.5]], maxCombos: 200,
			}),
		).toThrow(/over the 200 limit/);
	});

	it('refuses a spot that will not fit, with suggestions', () => {
		try {
			defineSpot({
				board: 'AsKh7d', pot: 100, stack: 500,
				oop: 'random', ip: 'random',
				betSizes: [[0.33, 0.75, 1.5]], maxRaises: 3,
				maxBytes: 64 * 1024 * 1024,
			});
			throw new Error('should have refused');
		} catch (error) {
			expect(error).toBeInstanceOf(SpotTooLargeError);
			const typed = error as SpotTooLargeError;
			expect(typed.estimate.fits).toBe(false);
			expect(typed.estimate.suggestions.length).toBeGreaterThan(0);
		}
	});

	it('rejects a betSizes row count that matches no round', () => {
		expect(() =>
			defineSpot({ board: 'AsKh7d', pot: 20, stack: 50, oop: 'AA', ip: 'KK', betSizes: [[0.5], [0.5]] }),
		).toThrow(/3 betting rounds/);
	});
});

describe('normalisation across entry points', () => {
	// A royal flush on the flop cannot be beaten or chopped by any runout, so
	// with betting switched off the holder simply wins the pot — whatever the
	// board still has to come. That pins the expected value to exactly half the
	// pot at every entry point, which is the one thing a runout-counting error
	// silently breaks: the traversal sums over every completion, so the
	// denominator has to count them too.
	it.each([
		['flop entry, 1980 completions', 'AsKsQs'],
		['turn entry, 44 completions', 'AsKsQs2d'],
		['river entry, 1 completion', 'AsKsQs2d3c'],
	])('%s', (_name, board) => {
		const pot = 80;
		const spot = defineSpot({
			board,
			pot,
			stack: 100,
			oop: 'JsTs',   // a royal flush, already made on the flop
			ip: '2h2c',
			betSizes: [[0.5]],
			maxRaises: 0,  // nobody can bet, so it is a pure showdown
		});
		const sol = solve(spot, { iterations: 20 });
		expect(sol.ev(0)).toBeCloseTo(pot / 2, 6);
		expect(sol.ev(1)).toBeCloseTo(-pot / 2, 6);
	});

	it('keeps the expected value inside what can actually be won', () => {
		const pot = 60;
		const stack = 120;
		const sol = solve(
			defineSpot({
				board: 'AsKh7d2c',
				pot, stack,
				oop: '22+,A2s+,KQo',
				ip: '22+,A8s+,KJo+',
				betSizes: [[0.5]],
				maxRaises: 1,
			}),
			{ iterations: 60 },
		);
		// The most anyone can win is the dead pot plus a full stack.
		expect(Math.abs(sol.ev(0))).toBeLessThanOrEqual(pot / 2 + stack);
		// And on a board like this, with similar ranges, it should be small.
		expect(Math.abs(sol.ev(0))).toBeLessThan(pot / 2);
	});
});

describe('worker parallelism', () => {
	// Sharding splits the runouts across threads, each owning a disjoint slice
	// of shared storage. It must be a pure speed-up. Agreement is to floating
	// point, not bit-for-bit: a worker sums its own slice before the totals are
	// summed across workers, which associates the runout sum differently. A
	// wrong slice boundary or a doubly applied update would show up far above
	// that noise floor. At 60 iterations the rounding gap is ~1e-15, four
	// orders under what is asserted; it widens with iteration count, because
	// the clamp is non-linear, so raising the count here wants a looser bound.
	const spot = () =>
		defineSpot({
			board: 'Qs Jh 4d 2c',
			pot: 40,
			stack: 60,
			oop: 'JJ, TT, AQs, KQs, QTs, J9s, 87s',
			ip: 'AA, KK, AJs, QJs, JTs, T9s, 65s',
			betSizes: [[0.75]],
			maxRaises: 1,
		});

	it('agrees with a single-threaded solve to the last bit', () => {
		const single = solve(spot(), { iterations: 60, workers: 1, algorithm: 'cfr+' });
		const shared = solve(spot(), { iterations: 60, workers: 4, algorithm: 'cfr+' });

		expect(shared.ev(0)).toBeCloseTo(single.ev(0), 10);
		expect(shared.ev(1)).toBeCloseTo(single.ev(1), 10);
		expect(shared.exploitability()).toBeCloseTo(single.exploitability(), 10);

		// EVs could match while individual strategies drifted, so check the
		// actual numbers a user reads off the screen.
		const node = single.spot.tree.decisionNodes[0];
		const a = single.strategyAt(node, 0);
		const b = shared.strategyAt(node, 0);
		for (let i = 0; i < a.probs.length; i++) expect(b.probs[i]).toBeCloseTo(a.probs[i], 10);
	});

	it('agrees with a single-threaded solve under discounted CFR', () => {
		// Unclamped regrets near zero change sign on rounding alone, so the gap
		// grows faster than under CFR+: ~1e-14 at 20 iterations, ~1e-10 by 60.
		// A wrong slice or a doubled update shows from the second iteration.
		const single = solve(spot(), { iterations: 20, workers: 1, algorithm: 'dcfr' });
		const shared = solve(spot(), { iterations: 20, workers: 4, algorithm: 'dcfr' });

		expect(shared.ev(0)).toBeCloseTo(single.ev(0), 10);
		expect(shared.exploitability()).toBeCloseTo(single.exploitability(), 10);
		const node = single.spot.tree.decisionNodes[0];
		const a = single.strategyAt(node, 0);
		const b = shared.strategyAt(node, 0);
		for (let i = 0; i < a.probs.length; i++) expect(b.probs[i]).toBeCloseTo(a.probs[i], 10);
	});

	it('measures exploitability and EV across threads as it would on one', () => {
		// Same accumulators, measured both ways: only the runout sum's
		// association may differ.
		const run = createRun(spot(), { workers: 4 });
		try {
			expect(run.workers).toBe(4);
			run.step(30);
			const pooled = run.snapshot();
			const pooledExploit = pooled.exploitability();
			const pooledEv = [pooled.ev(0), pooled.ev(1)];

			run.solver.useRoot(null);
			const alone = run.snapshot();
			expect(pooledExploit).toBeCloseTo(alone.exploitability(), 12);
			expect(pooledEv[0]).toBeCloseTo(alone.ev(0), 12);
			expect(pooledEv[1]).toBeCloseTo(alone.ev(1), 12);
		} finally {
			run.close();
		}
	});

	it('runs single-threaded when there is nothing to divide', () => {
		// A river spot has one runout; asking for workers must not hang or throw.
		const river = defineSpot({
			board: 'Qs Jh 4d 2c 9h',
			pot: 40,
			stack: 60,
			oop: 'JJ, TT, AQs',
			ip: 'AA, KK, AJs',
			betSizes: [[0.75]],
			maxRaises: 1,
		});
		const run = createRun(river, { workers: 4 });
		expect(run.workers).toBe(1);
		run.step(20);
		run.close();
	});
});

describe('accuracy targets', () => {
	const cfg = {
		board: 'As Kh 7d 2c',
		pot: 60,
		stack: 100,
		oop: '22+, A2s+, KTs+, QJs, AJo+, KQo',
		ip: '22+, A2s+, K9s+, Q9s+, JTs, ATo+, KJo+',
		betSizes: [[0.75]],
		maxRaises: 1,
	} as const;

	it('stops as soon as the requested accuracy is reached', () => {
		const loose = solve(defineSpot(cfg), { iterations: 4000, targetPercent: 1, workers: 1 });
		const tight = solve(defineSpot(cfg), { iterations: 4000, targetPercent: 0.1, workers: 1 });

		expect(loose.stoppedAt).toBe('target');
		expect(tight.stoppedAt).toBe('target');
		expect(loose.exploitabilityPercent()).toBeLessThanOrEqual(1);
		expect(tight.exploitabilityPercent()).toBeLessThanOrEqual(0.1);

		// The whole point is buying time back, so a looser target must cost
		// strictly fewer iterations, and neither may run to the cap.
		expect(loose.iterations).toBeLessThan(tight.iterations);
		expect(tight.iterations).toBeLessThan(4000);
	});

	it('says so when the target is out of reach instead of pretending', () => {
		const missed = solve(defineSpot(cfg), { iterations: 40, targetPercent: 0.001, workers: 1 });
		expect(missed.stoppedAt).toBe('iterations');
		expect(missed.iterations).toBe(40);
		expect(missed.exploitabilityPercent()).toBeGreaterThan(0.001);
	});

	it('schedules checks without perturbing the solve', () => {
		// Measuring is a best-response pass that writes nothing, so a run that
		// measures often must land on exactly the same answer as one that never
		// does. If this ever drifts, a check is mutating solver state.
		const quiet = solve(defineSpot(cfg), { iterations: 120, workers: 1 });
		const watched = solve(defineSpot(cfg), { iterations: 120, exploitEvery: 5, workers: 1 });
		const predicted = solve(defineSpot(cfg), {
			iterations: 120,
			// Unreachable, so this runs the full 120 while checking throughout.
			targetPercent: 1e-9,
			workers: 1,
		});

		expect(watched.ev(0)).toBe(quiet.ev(0));
		expect(predicted.ev(0)).toBe(quiet.ev(0));
		expect(watched.exploitability()).toBe(quiet.exploitability());
		expect(predicted.exploitability()).toBe(quiet.exploitability());

		// Predicting the crossing must take far fewer passes than a fixed cadence.
		expect(predicted.history.length).toBeLessThan(watched.history.length);
	});
});
