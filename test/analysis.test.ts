import { describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import { COMBOS } from '../src/cards.ts';

/**
 * Additions for reading a solved spot after the fact: raise sizes as a
 * multiple of the bet faced, `SolveRun.solver`, `Solver.valuesAt`, and
 * `analysisOnly` runs that hold a strategy without the means to train it.
 */

const river = () =>
	defineSpot({
		board: '2c7d9hJs3c',
		pot: 100,
		stack: 200,
		oop: 'JJ,TT,54s',
		ip: 'TT,99,A5s',
		betSizes: [[0.5]],
		maxRaises: 2,
	});

describe('raise sizes', () => {
	it('sizes a raise as a multiple of the bet faced', () => {
		const spot = defineSpot({
			board: 'As Kh 7d 2c 9s', pot: 80, stack: 1000, oop: 'AA', ip: 'KK',
			betSizes: [[0.5]], raiseSizes: [{ times: 3 }], maxRaises: 2,
		});
		const { tree, chipScale } = spot;
		// Root: check or bet 40. Facing the bet: fold, call, raise to 3 x 40.
		const facing = tree.edgeChild[tree.firstEdge[0] + 1];
		const targets = [];
		for (let e = 0; e < tree.numEdges[facing]; e++) targets.push(tree.edgeTarget[tree.firstEdge[facing] + e] / chipScale);
		expect(targets).toEqual([0, 40, 120]);
	});

	it('leaves bet sizes alone when no raise sizes are given', () => {
		const spot = defineSpot({
			board: 'As Kh 7d 2c 9s', pot: 80, stack: 1000, oop: 'AA', ip: 'KK',
			betSizes: [[0.5]], maxRaises: 2,
		});
		const { tree, chipScale } = spot;
		const facing = tree.edgeChild[tree.firstEdge[0] + 1];
		// Half the pot after calling: 40 + 0.5 * (80 + 40 + 40) = 120.
		expect(tree.edgeTarget[tree.firstEdge[facing] + 2] / chipScale).toBe(120);
	});
});

describe('valuesAt', () => {
	const run = createRun(river());
	run.step(300);
	const { solver } = run;
	const live = solver.rootLive.subarray(0, solver.rootCount);
	const reach = (p: 0 | 1) => Float64Array.from(solver.ctx.players[p].weights);

	it('is linear in the opponent reach, so values split by opponent hand', () => {
		const whole = solver.valuesAt(0, 0, 0, reach(0), reach(1), live, live.length);
		const sum = new Float64Array(COMBOS);
		for (const combo of solver.ctx.players[1].combos) {
			const one = new Float64Array(COMBOS);
			one[combo] = solver.ctx.players[1].weights[combo];
			const part = solver.valuesAt(0, 0, 0, reach(0), one, live, live.length);
			for (let c = 0; c < COMBOS; c++) sum[c] += part[c];
		}
		for (const combo of solver.ctx.players[0].combos) expect(sum[combo]).toBeCloseTo(whole[combo], 9);
	});

	it('only reads the strategy', () => {
		const before = Float64Array.from(solver.ctx.strategySum);
		solver.valuesAt(0, 0, 1, reach(1), reach(0), live, live.length);
		expect(Float64Array.from(solver.ctx.strategySum)).toEqual(before);
	});
});

describe('analysisOnly', () => {
	it('holds a strategy without regrets, and analyses it the same', () => {
		const spot = river();
		const solved = createRun(spot);
		solved.step(300);
		const loaded = createRun(spot, { analysisOnly: true });
		expect(loaded.solver.ctx.regret.length).toBe(0);
		expect(loaded.workers).toBe(1);
		loaded.solver.ctx.strategySum.set(solved.solver.ctx.strategySum);
		// The loaded copy is single precision, so agreement is to float accuracy.
		expect(loaded.exploitabilityPercent()).toBeCloseTo(solved.exploitabilityPercent(), 4);
	});
});

describe('pairValuesAt', () => {
	const spot = defineSpot({
		board: 'Ks7d2c3h', pot: 100, stack: 200,
		oop: '99+,A9s+,KTs+,QJs,AJo+', ip: '77+,A5s+,K9s+,QTs+,JTs,ATo+,KQo',
		betSizes: [[0.5, 1]], raiseSizes: [{ times: 3 }], maxRaises: 2,
	});
	const run = createRun(spot);
	run.step(40);
	const { solver } = run;
	const live = solver.rootLive.subarray(0, solver.rootCount);
	const oop = solver.ctx.players[0];
	const ip = solver.ctx.players[1];
	// After OOP bets, IP values against each OOP hand that bets.
	const bet = spot.tree.edgeChild[spot.tree.firstEdge[0] + 1];
	const root = solver.averageStrategyAt(0, 0);
	const hands = Uint16Array.from([...oop.combos].filter((c) => live.includes(c)));
	const reach = Float64Array.from(hands, (c) => oop.weights[c] * root.probs[oop.slot[c] * root.actions + 1]);
	const rows = solver.pairValuesAt(bet, 0, 1, hands, reach, live, live.length);

	it('matches valuesAt with a one-hot opponent reach, across chunks and streets', () => {
		// More hands than one walk takes, so chunking is exercised too.
		expect(hands.length).toBeGreaterThan(64);
		for (const k of [0, 1, 63, 64, 65, hands.length - 1]) {
			const one = new Float64Array(COMBOS);
			one[hands[k]] = reach[k];
			const expected = solver.valuesAt(bet, 0, 1, Float64Array.from(ip.weights), one, live, live.length);
			for (const combo of ip.combos) {
				if (!live.includes(combo)) continue;
				expect(rows[k * COMBOS + combo]).toBeCloseTo(expected[combo], 6);
			}
		}
	});

	it('sums back to the whole range', () => {
		const whole = solver.valuesAt(bet, 0, 1, Float64Array.from(ip.weights), (() => {
			const r = new Float64Array(COMBOS);
			hands.forEach((c, k) => (r[c] = reach[k]));
			return r;
		})(), live, live.length);
		for (const combo of ip.combos) {
			if (!live.includes(combo)) continue;
			let sum = 0;
			for (let k = 0; k < hands.length; k++) sum += rows[k * COMBOS + combo];
			expect(sum).toBeCloseTo(whole[combo], 6);
		}
	});

	it('gives nothing against a hand that never reaches the node', () => {
		const none = solver.pairValuesAt(bet, 0, 1, hands.subarray(0, 3), new Float64Array(3), live, live.length);
		expect(none.every((v) => v === 0)).toBe(true);
	});

	it('only reads the strategy', () => {
		const before = Float64Array.from(solver.ctx.strategySum);
		solver.pairValuesAt(bet, 0, 1, hands, reach, live, live.length);
		expect(Float64Array.from(solver.ctx.strategySum)).toEqual(before);
	});
});
