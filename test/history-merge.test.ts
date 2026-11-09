/**
 * History merging (issue #49): river storage shared between betting
 * histories that reach the same round start.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import type { SolveOptions, SpotConfig } from '../src/index.ts';
import { dither } from '../src/cfr.ts';
import { engineAvailable } from '../src/engine.ts';
import { aliasHistories } from '../src/history-merge.ts';
import { wasmStorage } from '../src/wasm-storage.ts';
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
	it('shares the river between lines that reach the same pot, and no others', () => {
		const spot = defineSpot(flop);
		const { Check, Bet, Call } = ActionKind;
		const share = aliasHistories(spot.tree, spot.runouts);
		// One bet called, on the flop or on the turn: the same river pot.
		const betCall = follow(spot.tree, [Bet, Call, Check, Check]);
		const checkBetCall = follow(spot.tree, [Check, Bet, Call, Check, Check]);
		const turnBetCall = follow(spot.tree, [Check, Check, Check, Bet, Call]);
		const checkCheck = follow(spot.tree, [Check, Check, Check, Check]);
		expect(spot.tree.round[betCall]).toBe(2);
		// Checks are built first, so the line checking longest owns the storage.
		expect(share.alias[betCall]).toBe(turnBetCall);
		expect(share.alias[checkBetCall]).toBe(turnBetCall);
		expect(share.alias[turnBetCall]).toBe(turnBetCall);
		expect(share.alias[checkCheck]).toBe(checkCheck);
		// Node by node below, not only at the root.
		expect(share.alias[follow(spot.tree, [Bet, Call, Check, Check, Check])]).toBe(
			follow(spot.tree, [Check, Check, Check, Bet, Call, Check]),
		);
		// The turn keeps storage of its own.
		const turn = follow(spot.tree, [Bet, Call]);
		expect(share.alias[turn]).toBe(turn);
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
		expect(defineSpot({ ...flop, shareHistories: {} }).estimate).toEqual(shared.estimate);
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

	it('discounts a shared block once an iteration, in every engine and precision', () => {
		// DCFR halves negative regrets and discounts the sums from iteration 2.
		// Discounting a shared block once per history put the JavaScript
		// engine 1.5 chips of EV away from the WebAssembly one there; once an
		// iteration, they agree to 4e-7. Compared at 2 iterations because
		// from 3 on, regret matching amplifies float32 against float64
		// rounding (as it does threads') faster than tolerances can follow.
		const shared = { ...flop, shareHistories: true };
		const js = run(shared, 2, { engine: 'js', precision: 'f64' });
		const wasm = run(shared, 2, { precision: 'f32' });
		const i16 = run(shared, 2, { precision: 'i16' });
		expect(wasm.engine).toBe('wasm');
		expect(wasm.ev).toBeCloseTo(js.ev, 3);
		expect(wasm.exploitability).toBeCloseTo(js.exploitability, 2);
		expect(i16.ev).toBeCloseTo(js.ev, 2);
		expect(i16.exploitability).toBeCloseTo(js.exploitability, 1);
	});

	/**
	 * Step a shared 32-bit solve and a shared compact one with 32-bit
	 * regrets from the turn, and count the compact slots whose regret is
	 * more than `tolerance` of the largest regret from the 32-bit one's.
	 */
	function compactAgainstExact(exactOptions: SolveOptions, compactOptions: SolveOptions, tolerance: number) {
		const shared = { ...flop, shareHistories: true };
		const exact = createRun(defineSpot(shared), { workers: 1, algorithm: 'dcfr', ...exactOptions });
		const compact = createRun(defineSpot({ ...shared, compactStorage: { from: 1, float: true, sums: false } }), {
			workers: 1, algorithm: 'dcfr', ...compactOptions,
		});
		try {
			exact.step(6);
			compact.step(6);
			const { tree } = compact.spot;
			const layout = compact.solver.ctx.layout;
			expect(layout.shared).toBe(true);
			// One chunk, so offsets into it are offsets into all compact storage.
			expect(compact.solver.ctx.compactRegret!.length).toBe(1);
			const q = compact.solver.ctx.compactRegret![0];
			const regret = exact.solver.ctx.regret;
			// Each owner's slots, in storage order; an aliased node shares its owner's.
			const owners = new Map<number, number>();
			for (const node of tree.decisionNodes) {
				if (tree.round[node] >= layout.compactFrom && !owners.has(layout.offset[node])) owners.set(layout.offset[node], node);
			}
			const starts = [...owners.keys()].sort((a, b) => a - b);
			let largest = 0;
			for (let i = 0; i < regret.length; i++) largest = Math.max(largest, Math.abs(regret[i]));
			let compared = 0;
			let differ = 0;
			starts.forEach((start, k) => {
				const from = exact.solver.ctx.layout.offset[owners.get(start)!];
				const end = k + 1 < starts.length ? starts[k + 1] : layout.compactSlots;
				for (let i = 0; i < end - start; i++) {
					if (Math.abs(q[start + i] - regret[from + i]) > tolerance * largest) differ++;
					compared++;
				}
			});
			expect(compared).toBeGreaterThan(0);
			return { differ, exact: exact.snapshot().strategyAt(0, 0).probs, compact: compact.snapshot().strategyAt(0, 0).probs, engine: compact.engine };
		} finally {
			exact.close();
			compact.close();
		}
	}

	it('discounts a shared compact block once an iteration', () => {
		// With 32-bit regrets kept, compact storage trains exactly as the
		// 32-bit solve; shared, only if it too discounts a block once.
		const js = compactAgainstExact({ engine: 'js' }, {}, 0);
		expect(js.engine).toBe('js');
		expect(js.differ).toBe(0);
		expect(Array.from(js.compact)).toEqual(Array.from(js.exact));
	});

	it.runIf(engineAvailable())('discounts a shared compact block once an iteration on the WebAssembly engine', () => {
		// The storage engine against the 32-bit WebAssembly one, both float32.
		const wasm = compactAgainstExact({}, { wasmStorage }, 1e-4);
		expect(wasm.engine).toBe('wasm');
		expect(wasm.differ).toBe(0);
		for (let i = 0; i < wasm.exact.length; i++) expect(wasm.compact[i]).toBeCloseTo(wasm.exact[i], 4);
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

	it('dithers 16-bit sums with a stream per shared history, and unshared ones as before', () => {
		// Every history that reaches a shared block re-encodes it in an
		// iteration; on one stream their random roundings pushed the same way
		// (issue #94). `updateQuantised` salts the stream with the history's
		// node when storage is shared and with 0 otherwise.
		const unsalted = (slot: number, iteration: number) => {
			let h = Math.imul(slot ^ Math.imul(iteration, 0x9e3779b1), 0x85ebca6b);
			h ^= h >>> 13;
			h = Math.imul(h, 0xc2b2ae35);
			h ^= h >>> 16;
			return (h >>> 0) / 4294967296;
		};
		for (const [slot, iteration] of [[0, 1], [7, 2], [12345, 99], [2 ** 30, 7]]) {
			expect(dither(slot, iteration, 0)).toBe(unsalted(slot, iteration));
			expect(dither(slot, iteration)).toBe(unsalted(slot, iteration));
		}
		// Two histories' nodes, neighbouring or not: their uniforms for one
		// slot never coincide and are uncorrelated.
		for (const [a, b] of [[0, 1], [41, 42], [3, 1000]]) {
			let same = 0;
			let product = 0;
			const n = 20000;
			for (let k = 0; k < n; k++) {
				const slot = k * 7;
				const iteration = 1 + (k % 50);
				const u = dither(slot, iteration, a);
				const v = dither(slot, iteration, b);
				expect(u).not.toBe(v);
				if (u < 0.5 === v < 0.5) same++;
				product += u * v;
			}
			expect(Math.abs(same / n - 0.5)).toBeLessThan(0.02);
			expect(Math.abs(product / n - 0.25)).toBeLessThan(0.01);
		}
	});

	it('warm-starts shared storage only from shared storage', () => {
		const plain = createRun(defineSpot(flop), { workers: 1 });
		const shared = createRun(defineSpot({ ...flop, shareHistories: true }), { workers: 1 });
		try {
			plain.step(5);
			shared.step(5);
			// One history's regrets would overwrite the others' in every shared block.
			expect(() => createRun(defineSpot({ ...flop, shareHistories: true }), { workers: 1, warmStart: plain })).toThrow(
				/shareHistories/,
			);
			// The other way each node takes its owner's block: the shared strategy itself.
			const expanded = createRun(defineSpot(flop), { workers: 1, warmStart: shared, warmIteration: 5 });
			try {
				expect(expanded.warmStart?.matchedNodes).toBe(expanded.spot.tree.decisionNodes.length);
			} finally {
				expanded.close();
			}
		} finally {
			plain.close();
			shared.close();
		}
	});
});
