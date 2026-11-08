/**
 * History merging (issue #49): turn and river storage shared between betting
 * histories that reach the same round start.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import type { SolveOptions, SpotConfig } from '../src/index.ts';
import { aliasHistories } from '../src/history-merge.ts';
import { ActionKind, NodeKind } from '../src/tree.ts';
import type { Tree } from '../src/tree.ts';
import { SPOTS } from '../bench/compare/spots.ts';

const flop: SpotConfig = {
	board: 'Ts 9s 4h', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};

/** The node reached by following actions from the root, chance nodes passed through. */
function follow(tree: Tree, actions: number[]): number {
	let node = 0;
	for (const action of actions) {
		while (tree.kind[node] === NodeKind.Chance) node = tree.edgeChild[tree.firstEdge[node]];
		const first = tree.firstEdge[node];
		let next = -1;
		for (let i = 0; i < tree.numEdges[node]; i++) if (tree.edgeAction[first + i] === action) next = tree.edgeChild[first + i];
		if (next < 0) throw new Error(`no action ${action} at node ${node}`);
		node = next;
	}
	while (tree.kind[node] === NodeKind.Chance) node = tree.edgeChild[tree.firstEdge[node]];
	return node;
}

function run(config: SpotConfig, iterations: number, options: SolveOptions) {
	const solve = createRun(defineSpot(config), { workers: 1, ...options });
	try {
		solve.step(iterations);
		return { ev: solve.snapshot().ev(0), exploitability: solve.exploitabilityPercent(), engine: solve.engine };
	} finally {
		solve.close();
	}
}

describe('history merging', () => {
	it('shares the turn between lines that reach the same pot, and no others', () => {
		const spot = defineSpot(flop);
		const { Check, Bet, Call } = ActionKind;
		const share = aliasHistories(spot.tree, spot.runouts, { key: { kind: 'exact' }, fromRound: 1 });
		const betCall = follow(spot.tree, [Bet, Call]);
		const checkBetCall = follow(spot.tree, [Check, Bet, Call]);
		const checkCheck = follow(spot.tree, [Check, Check]);
		expect(spot.tree.round[betCall]).toBe(1);
		// The check is built first, so its line owns the storage.
		expect(share.alias[betCall]).toBe(checkBetCall);
		expect(share.alias[checkBetCall]).toBe(checkBetCall);
		expect(share.alias[checkCheck]).toBe(checkCheck);
		// Node by node below, not only at the root.
		expect(share.alias[follow(spot.tree, [Bet, Call, Check])]).toBe(follow(spot.tree, [Check, Bet, Call, Check]));
	});

	it('leaves a spot untouched when off', () => {
		const plain = defineSpot(SPOTS.turn);
		const off = defineSpot({ ...SPOTS.turn, shareHistories: false });
		expect(off.estimate).toEqual(plain.estimate);
		const a = run(SPOTS.turn, 20, { engine: 'js', precision: 'f64' });
		const b = run({ ...SPOTS.turn, shareHistories: false }, 20, { engine: 'js', precision: 'f64' });
		expect(b.ev).toBe(a.ev);
		expect(b.exploitability).toBe(a.exploitability);
	});

	it('cuts storage by the shared nodes', () => {
		const plain = defineSpot(flop);
		const shared = defineSpot({ ...flop, shareHistories: true });
		expect(shared.estimate.bytes).toBeLessThan(plain.estimate.bytes);
		expect(shared.estimate.compressedBytes).toBeLessThan(plain.estimate.compressedBytes);
		const river = defineSpot({ ...flop, shareHistories: { fromRound: 2 } });
		expect(river.estimate.bytes).toBeLessThan(plain.estimate.bytes);
		expect(river.estimate.bytes).toBeGreaterThanOrEqual(shared.estimate.bytes);
		const spr = defineSpot({ ...flop, shareHistories: { spr: 1 } });
		expect(spr.estimate.bytes).toBeLessThanOrEqual(shared.estimate.bytes);
	});

	it('changes nothing where no two histories meet', () => {
		// A river spot has no later round to share.
		const a = run(SPOTS.river, 20, { engine: 'js', precision: 'f64' });
		const b = run({ ...SPOTS.river, shareHistories: true }, 20, { engine: 'js', precision: 'f64' });
		expect(b.ev).toBe(a.ev);
		expect(b.exploitability).toBe(a.exploitability);
	});

	it('converges to a strategy for the full game, short of its equilibrium', () => {
		// One strategy for lines whose ranges differ is the approximation:
		// measured in the full game, it settles near 1.5% of pot here where the
		// unshared solve goes on to 0.01%.
		const shared = { ...flop, shareHistories: true };
		const early = run(shared, 10, { precision: 'f32' });
		const late = run(shared, 200, { precision: 'f32' });
		expect(late.exploitability).toBeLessThan(early.exploitability / 3);
		expect(late.exploitability).toBeLessThan(2.5);
	});

	it('weights shared regrets by own reach unless asked not to', () => {
		const reach = run({ ...flop, shareHistories: true }, 200, { precision: 'f32' });
		const plain = run({ ...flop, shareHistories: { weighting: 'counterfactual' } }, 200, { precision: 'f32' });
		expect(reach.exploitability).toBeLessThan(plain.exploitability / 2);
	});

	it('discounts a shared block once an iteration, in every engine and precision', () => {
		// DCFR halves negative regrets and discounts the sums from iteration 2.
		// Discounting a shared block once per history put the JavaScript
		// engine 1.5 chips of EV away from the WebAssembly one there; once an
		// iteration, they agree to 4e-7. Compared at 2 iterations because
		// from 3 on, regret matching amplifies float32 against float64
		// rounding (as it does threads') faster than tolerances can follow.
		for (const weighting of ['reach', 'counterfactual'] as const) {
			const shared = { ...flop, shareHistories: { weighting } };
			const js = run(shared, 2, { engine: 'js', precision: 'f64' });
			const wasm = run(shared, 2, { precision: 'f32' });
			const i16 = run(shared, 2, { precision: 'i16' });
			expect(wasm.engine).toBe('wasm');
			expect(wasm.ev).toBeCloseTo(js.ev, 3);
			expect(wasm.exploitability).toBeCloseTo(js.exploitability, 2);
			expect(i16.ev).toBeCloseTo(js.ev, 2);
			expect(i16.exploitability).toBeCloseTo(js.exploitability, 1);
		}
	});

	it('gives the same answer on threads', () => {
		// Through the first discounts. Later the threads' different order of
		// addition grows, as unshared, only faster: 1e-15 of a chip at two
		// iterations, 1e-5 at three and 1e-3 at five on this spot.
		const shared = { ...flop, shareHistories: true };
		for (const options of [{ engine: 'js', precision: 'f64' }, { precision: 'f32' }, { precision: 'i16' }] as const) {
			const one = run(shared, 2, options);
			const four = run(shared, 2, { ...options, workers: 4 });
			expect(four.ev).toBeCloseTo(one.ev, options.precision === 'f64' ? 9 : 4);
			expect(four.exploitability).toBeCloseTo(one.exploitability, options.precision === 'f64' ? 9 : 3);
		}
	});
});
