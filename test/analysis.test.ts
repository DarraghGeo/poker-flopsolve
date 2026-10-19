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
