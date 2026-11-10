/**
 * Re-solving a street of a Lite solve on the benchmark page (issue #147):
 * the subgame a dealt card opens, at the caller's own betting.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, litePreset, SpotTooLargeError } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { nodeView, runoutsOf, stepOf } from '../site/lib/explore.ts';
import { resolvePlan, RIVER_TARGET } from '../site/lib/resolve.ts';

/** Two bet sizes and two raises: Lite keeps one size and no raise past the flop. */
const source: SpotConfig = {
	board: 'Ks 9d 4c',
	pot: 10,
	stack: 60,
	oop: 'AA,KQs,98s,76s',
	ip: 'KK,AKo,T9s,QJs',
	betSizes: [[0.33, 1]],
	raiseSizes: [{ times: 3 }],
	maxRaises: 3,
};

const preset = litePreset(source, { workers: 1 });
const blueprint = defineSpot(preset.config);
const solution = (() => {
	const run = createRun(blueprint, { ...preset.options, workers: 1 });
	run.step(10);
	return run.snapshot();
})();

/** The turn after check, check, and the river after check, check again. */
const turn = stepOf(blueprint, stepOf(blueprint, 0, 0, 0)!.node, 0, 0)!;

describe('site resolve', () => {
	it('re-solves a turn at the caller\'s betting, Lite on the river', () => {
		expect(turn).toMatchObject({ dealt: true, round: 1 });
		// The blueprint's turn has Lite's one size, the caller's nearest 75%: check or bet 10.
		expect(nodeView(blueprint, solution, turn.node, turn.board).actions).toEqual(['check', 'bet 10']);
		const plan = resolvePlan(source, solution, turn.node, turn.board, 0, 2 ** 30);
		expect(plan.round).toBe(1);
		expect(plan.config.board.split(' ')).toHaveLength(4);
		expect(plan.settle).not.toBeNull();
		expect(plan.target).toBeNull();
		const sub = defineSpot(plan.config);
		const run = createRun(sub, { ...plan.options, workers: 1 });
		run.step(5);
		const view = nodeView(sub, run.snapshot(), 0, 0);
		// Both sizes are back on the turn.
		expect(view.actions).toEqual(['check', 'bet 3.3', 'bet 10']);
		const facing = nodeView(sub, run.snapshot(), view.next[1]!.node, 0);
		// And the raise, 3× the bet.
		expect(facing.actions).toEqual(['fold', 'call', 'raise 9.9']);
		run.close();
	});

	it('re-solves the river from a re-solved turn in full, to a target', () => {
		const turnPlan = resolvePlan(source, solution, turn.node, turn.board, 0, 2 ** 30);
		const turnSpot = defineSpot(turnPlan.config);
		const turnRun = createRun(turnSpot, { ...turnPlan.options, workers: 1 });
		turnRun.step(5);
		const turnSolution = turnRun.snapshot();
		// Lite simplified the river of the turn subgame: one size, no small bet.
		const river = stepOf(turnSpot, stepOf(turnSpot, 0, 0, 0)!.node, 0, 0)!;
		expect(nodeView(turnSpot, turnSolution, river.node, river.board).actions).toEqual(['check', 'bet 10']);
		const plan = resolvePlan(source, turnSolution, river.node, river.board, turnPlan.round, 2 ** 30);
		expect(plan.round).toBe(2);
		expect(plan.settle).toBeNull();
		expect(plan.target).toBe(RIVER_TARGET);
		const sub = defineSpot(plan.config);
		const run = createRun(sub, { workers: 1 });
		run.step(5);
		expect(nodeView(sub, run.snapshot(), 0, 0).actions).toEqual(['check', 'bet 3.3', 'bet 10']);
		run.close();
		turnRun.close();
	});

	it('refuses a subgame over the memory limit', () => {
		const plan = resolvePlan(source, solution, turn.node, turn.board, 0, 1024);
		expect(() => defineSpot(plan.config)).toThrow(SpotTooLargeError);
	});

	it('lists the cards that could have come where a street opens', () => {
		const offered = runoutsOf(blueprint, turn.round, turn.board);
		expect(offered).toEqual(nodeView(blueprint, solution, turn.node, turn.board).runouts);
		expect(offered.map((r) => r.board)).toContain(turn.board);
		expect(runoutsOf(blueprint, 0, 0)).toEqual([]);
	});
});
