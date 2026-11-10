/**
 * EV as a share of the flop pot (issue #130).
 *
 * `ev` and `handEvs` report what a player wins as a percentage of the pot the
 * spot starts with: folding or losing everything is 0, winning the whole pot
 * uncontested is 100, and the two players' values add up to 100. A subgame
 * re-solved from a solution reports in the original spot's pot, so values
 * read the same way down a hand; `evPot` says which pot that is.
 */

import { describe, expect, it } from 'vitest';
import { COMBO_CARDS, COMBOS, createRun, defineSpot, NodeKind, resolveSubgame, solve, solveLite } from '../src/index.ts';
import type { Solution, SpotConfig } from '../src/index.ts';

/** Mean of per-hand EVs weighted by range weight times compatible opponent mass. */
function weightedMean(solution: Solution, player: 0 | 1): number {
	const evs = solution.handEvs(player);
	const mine = solution.spot.players[player].weights;
	const theirs = solution.spot.players[1 - player].weights;
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

const turn: SpotConfig = {
	board: 'Qs Jh 4d 2c',
	pot: 40,
	stack: 60,
	oop: 'JJ, TT, AQs, KQs, QTs, J9s, 87s, AJo',
	ip: 'AA, KK, AJs, QJs, JTs, T9s, 65s, KQo',
	betSizes: [[0.75]],
	maxRaises: 1,
};

describe('ev as a percentage of the flop pot', () => {
	const sol = solve(defineSpot(turn), { iterations: 300, workers: 1 });

	it('adds up to 100 between the players', () => {
		expect(sol.evPot).toBe(turn.pot);
		expect(sol.ev(0) + sol.ev(1)).toBeCloseTo(100, 6);
		expect(sol.ev(0)).toBeGreaterThan(0);
		expect(sol.ev(0)).toBeLessThan(100);
	});

	it('converts from chips on the half-pot baseline', () => {
		for (const player of [0, 1] as const) {
			expect(sol.ev(player)).toBeCloseTo((100 * (sol.evChips(player) + turn.pot / 2)) / turn.pot, 9);
		}
		expect(sol.evChips(0) + sol.evChips(1)).toBeCloseTo(0, 9);
	});

	it('averages handEvs back to ev', () => {
		for (const player of [0, 1] as const) expect(weightedMean(sol, player)).toBeCloseTo(sol.ev(player), 9);
	});

	it('is 0 for a hand that can only fold or lose, and 100 for one that wins the pot', () => {
		// OOP's air never wins a showdown, so it checks and folds to a bet:
		// worth nothing. IP's nuts collect the whole pot at least.
		const spot = defineSpot({
			board: '2c 7d 9h Js 3c', pot: 100, stack: 100,
			oop: '54s', ip: 'JJ', betSizes: [[0.75]], maxRaises: 1,
		});
		const folded = solve(spot, { iterations: 200, workers: 1 });
		expect(folded.ev(0)).toBeCloseTo(0, 3);
		expect(folded.ev(1)).toBeCloseTo(100, 3);
		const evs = folded.handEvs(0);
		for (const combo of spot.players[0].combos) expect(evs[combo]).toBeCloseTo(0, 3);
	});

	it('measures against the pot as rounded to chip units, so a fold is exactly 0', () => {
		// 55.555 rounds to 55.56 at the default chip scale of 100.
		const spot = defineSpot({ board: 'As Ks Qs 2d 3c', pot: 55.555, stack: 100, oop: 'JsTs', ip: '2h2c', betSizes: [[0.5]], maxRaises: 0 });
		const shown = solve(spot, { iterations: 5 });
		expect(shown.evPot).toBe(spot.potUnits / spot.chipScale);
		expect(shown.ev(1)).toBeCloseTo(0, 9);
		expect(shown.ev(0)).toBeCloseTo(100, 9);
	});

	it('refuses an evPot that is not a positive finite number', () => {
		for (const evPot of [0, -1, Infinity, Number.NaN]) {
			expect(() => defineSpot({ ...turn, evPot })).toThrow(/evPot/);
		}
	});

	it('gives handEvsChips on the half-pot baseline', () => {
		for (const player of [0, 1] as const) {
			const pct = sol.handEvs(player);
			const chips = sol.handEvsChips(player);
			for (const combo of sol.spot.players[player].combos) {
				if (pct[combo] === 0 && chips[combo] === 0) continue;
				expect(chips[combo]).toBeCloseTo((pct[combo] / 100) * turn.pot - turn.pot / 2, 9);
			}
		}
	});

	it('values a pure showdown at 100 and 0', () => {
		const spot = defineSpot({ board: 'As Ks Qs 2d 3c', pot: 80, stack: 100, oop: 'JsTs', ip: '2h2c', betSizes: [[0.5]], maxRaises: 0 });
		const shown = solve(spot, { iterations: 20 });
		expect(shown.ev(0)).toBeCloseTo(100, 6);
		expect(shown.ev(1)).toBeCloseTo(0, 6);
	});
});

describe('a re-solved subgame', () => {
	const run = createRun(defineSpot(turn), { workers: 1 });
	run.step(1000);
	const sol = run.snapshot();
	const { tree } = sol.spot;
	/** The river decision after bet and call on the turn. */
	const called = (() => {
		for (let node = 0; node < tree.nodeCount; node++) {
			if (tree.kind[node] !== NodeKind.Chance) continue;
			const child = tree.edgeChild[tree.firstEdge[node]];
			if (sol.path(child) === 'bet 30 call /') return child;
		}
		throw new Error('no called river');
	})();

	it('carries the original pot, not its own', () => {
		const config = sol.subgameAt(called, 0);
		expect(config.pot).toBe(tree.pot[called] / sol.spot.chipScale);
		expect(config.pot).toBeGreaterThan(turn.pot);
		expect(config.evPot).toBe(turn.pot);
		const sub = solve(defineSpot(config), { iterations: 300, workers: 1 });
		expect(sub.evPot).toBe(turn.pot);
		expect(sub.ev(0) + sub.ev(1)).toBeCloseTo(100, 6);
		for (const player of [0, 1] as const) {
			expect(sub.ev(player)).toBeCloseTo((100 * (sub.evChips(player) + turn.pot / 2)) / turn.pot, 9);
			expect(weightedMean(sub, player)).toBeCloseTo(sub.ev(player), 9);
		}
	});

	it('warm-starts averages between a subgame config and the same spot without evPot', () => {
		const config = sol.subgameAt(called, 0);
		const { evPot: _evPot, ...plain } = config;
		const first = createRun(defineSpot(plain), { workers: 1 });
		first.step(20);
		const warm = createRun(defineSpot(config), { workers: 1, warmStart: first });
		try {
			expect(warm.warmStart?.averages).toBe(true);
		} finally {
			first.close();
			warm.close();
		}
	});

	it('keeps the original pot when nested', () => {
		const first = resolveSubgame(sol, called, 0, { player: 0, iterations: 20 });
		expect(first.solution.evPot).toBe(turn.pot);
		// A subgame of a subgame: its root again, which still opens a round.
		expect(first.solution.subgameAt(0, 0).evPot).toBe(turn.pot);
	});

	it('reports a fold at its root below 0: the chips put in before it', () => {
		// IP's air facing a river shove after calling the turn bet loses that call.
		const config = { ...sol.subgameAt(called, 0), oop: 'JJ', ip: '65s', betSizes: [[2]], allowAllIn: true };
		const spot = defineSpot(config);
		const sub = solve(spot, { iterations: 400, workers: 1 });
		const invested = (spot.potUnits / spot.chipScale - turn.pot) / 2;
		expect(sub.ev(1)).toBeCloseTo((-100 * invested) / turn.pot, 1);
		expect(sub.ev(0) + sub.ev(1)).toBeCloseTo(100, 6);
	});

	it('is in the flop pot through solveLite', () => {
		const flop: SpotConfig = {
			board: 'Ks 9d 4c', pot: 60, stack: 100,
			oop: 'AA, KK, AK, KQs, 99, 44, QJs', ip: 'QQ, JJ, TT, AQs, KJs, T9s, 87s',
			betSizes: [[0.33], [0.5, 1], [0.5, 1]], maxRaises: 1,
		};
		const lite = solveLite(flop, { workers: 1, iterations: 30, settle: false, sampling: false });
		expect(lite.solution.evPot).toBe(60);
		expect(lite.solution.ev(0) + lite.solution.ev(1)).toBeCloseTo(100, 6);
		const t = lite.solution.spot.tree;
		const chance = t.edgeChild[t.firstEdge[t.edgeChild[t.firstEdge[0]]]];
		const next = t.edgeChild[t.firstEdge[chance]];
		const resolved = lite.resolve(next, 0, { player: 0, iterations: 20 });
		expect(resolved.solution.evPot).toBe(60);
		expect(resolved.solution.ev(0) + resolved.solution.ev(1)).toBeCloseTo(100, 6);
	});
});
