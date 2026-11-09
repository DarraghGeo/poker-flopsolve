/**
 * 16-bit and compact storage on the WebAssembly engine (issue #84), and the
 * `compactStorage` combinations that issue lifted.
 *
 * The engine works its updates from 32-bit vectors where JavaScript has
 * 64-bit ones, so the two cannot agree bit for bit once a value is rounded
 * to 16 or 8 bits: a value within float32 precision of a rounding boundary
 * can land either side, and from there the solves drift apart. So the
 * step-for-step tests copy JavaScript's storage into the engine before each
 * iteration, step both, and require nearly every stored value to match; the
 * rest of the tests hold whole solves to the same accuracy.
 */

import { describe, expect, it } from 'vitest';
import { COMBOS } from '../src/cards.ts';
import { buildActiveLists, buildLayout, Mode, runoutWeights } from '../src/cfr.ts';
import type { CompactPlan } from '../src/cfr.ts';
import type { Engine } from '../src/engine.ts';
import { createEngine, engineAvailable } from '../src/engine.ts';
import { buildHandSpace } from '../src/hands.ts';
import { createRun, defineSpot, NodeKind, resolveSubgame } from '../src/index.ts';
import type { SolveOptions, SpotConfig } from '../src/index.ts';
import { planShards } from '../src/parallel.ts';
import { spawnEngineWorker } from '../src/platform/node.ts';
import { buildShowdownTable } from '../src/showdown.ts';
import { wasmStorage } from '../src/wasm-storage.ts';
import { compareStorage, copyStorage } from './wasm-storage-helpers.ts';

const flop: SpotConfig = {
	board: 'Ts 9s 4h', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};

const turn: SpotConfig = { ...flop, board: 'Ts 9s 4h 2c' };

/** Each case: a spot, solve options, and the most of any stored array allowed to differ after a step. */
const CASES: [string, SpotConfig, SolveOptions, number][] = [
	['i16 under DCFR', flop, { precision: 'i16' }, 0.02],
	['i16 under CFR+', flop, { precision: 'i16', algorithm: 'cfr+' }, 0.02],
	['i16 with shared histories', { ...flop, shareHistories: true }, { precision: 'i16' }, 0.03],
	['compact storage under DCFR', { ...flop, compactStorage: {} }, {}, 0.002],
	['compact storage under CFR+', { ...flop, compactStorage: {} }, { algorithm: 'cfr+' }, 0.002],
	['compact storage from the turn, i16 before', { ...flop, compactStorage: { from: 1 } }, { precision: 'i16' }, 0.02],
	['compact storage without sums', { ...flop, compactStorage: { sums: false } }, {}, 0.002],
	['compact storage with a block scale', { ...flop, compactStorage: { sums: false, blockScale: true } }, {}, 0.002],
	['compact storage with shared histories', { ...flop, shareHistories: true, compactStorage: {} }, {}, 0.002],
	[
		'compact storage with a block scale and shared histories',
		{ ...flop, shareHistories: true, compactStorage: { sums: false, blockScale: true } }, {}, 0.002,
	],
	['compact storage with 32-bit regrets', { ...flop, compactStorage: { sums: false, float: true } }, {}, 0.01],
	[
		'compact storage with shared histories',
		{ ...flop, shareHistories: true, compactStorage: {} }, {}, 0.002,
	],
	[
		'compact storage with shared histories and 32-bit regrets',
		{ ...flop, shareHistories: true, compactStorage: { sums: false, float: true } }, {}, 0.01,
	],
	['compact storage rounded to nearest', { ...flop, compactStorage: { nearest: true, steps: 100 } }, {}, 0.01],
	[
		'compact storage with chance sampling',
		{ ...flop, compactStorage: { from: 1 } }, { approximations: { chanceSampling: { p: 0.5 } } }, 0.01,
	],
];

describe.runIf(engineAvailable())('16-bit and compact storage on the WebAssembly engine', () => {
	it('is opt-in: without wasmStorage those solves run on JavaScript, and 32-bit ones are unchanged with it', () => {
		for (const [config, options] of [[flop, { precision: 'i16' }], [{ ...flop, compactStorage: {} }, {}]] as const) {
			const run = createRun(defineSpot(config), { workers: 1, ...options });
			expect(run.engine).toBe('js');
			run.close();
			const opted = createRun(defineSpot(config), { workers: 1, ...options, wasmStorage });
			expect(opted.engine).toBe('wasm');
			opted.close();
		}
		// 'js' still forces JavaScript, and float64 has no engine.
		for (const options of [{ precision: 'i16', engine: 'js' }, { precision: 'f64' }] as const) {
			const run = createRun(defineSpot(flop), { workers: 1, ...options, wasmStorage });
			expect(run.engine).toBe('js');
			run.close();
		}
		const plain = createRun(defineSpot(flop), { workers: 1 });
		const opted = createRun(defineSpot(flop), { workers: 1, wasmStorage });
		plain.step(5);
		opted.step(5);
		expect(opted.engine).toBe('wasm');
		expect(opted.solver.ctx.regret).toEqual(plain.solver.ctx.regret);
		expect(opted.solver.ctx.strategySum).toEqual(plain.solver.ctx.strategySum);
		plain.close();
		opted.close();
	});

	for (const [label, config, options, allowed] of CASES) {
		for (const workers of options.approximations?.chanceSampling ? [1] : [1, 3]) {
			it(`follows the JavaScript update step for step: ${label}, ${workers} thread${workers > 1 ? 's' : ''}`, () => {
				const js = createRun(defineSpot(config), { workers: 1, ...options });
				const engine = createRun(defineSpot(config), { workers, ...options, wasmStorage });
				try {
					expect(js.engine).toBe('js');
					expect(engine.engine).toBe('wasm');
					expect(engine.workers).toBe(workers);
					for (let t = 1; t <= 6; t++) {
						copyStorage(engine, js);
						js.step(1);
						engine.step(1);
						for (const [name, share] of compareStorage(js, engine)) {
							// Counters and marks are never rounded: they match exactly.
							const exact = name === 'lastWalk' || name === 'lastUpdate' || name === 'discounted';
							expect(share, `${name} after iteration ${t}`).toBeLessThanOrEqual(exact ? 0 : allowed);
						}
					}
				} finally {
					js.close();
					engine.close();
				}
			});
		}
	}

	it('salts the 16-bit dither with the history under shared storage, as JavaScript does', () => {
		// Issue #94. With the same stream, the engines' sums agree on all but a
		// few slots that float32 puts across a rounding boundary (0.01% here);
		// with one engine unsalted, 3% of them differ after one iteration.
		const config = { ...flop, shareHistories: true };
		for (const workers of [1, 3]) {
			const js = createRun(defineSpot(config), { workers: 1, precision: 'i16' });
			const engine = createRun(defineSpot(config), { workers, precision: 'i16', wasmStorage });
			try {
				expect(engine.engine).toBe('wasm');
				js.step(1);
				engine.step(1);
				expect(compareStorage(js, engine).get('strategySum')).toBeLessThanOrEqual(0.005);
			} finally {
				js.close();
				engine.close();
			}
		}
	});

	it('floors a negative regret under CFR+ at 16 bits and compact, as JavaScript does', () => {
		// Only a warm start from a DCFR solve brings negative regrets into a CFR+ one.
		for (const [config, options] of [[flop, { precision: 'i16' }], [{ ...flop, compactStorage: {} }, {}]] as [SpotConfig, SolveOptions][]) {
			const dcfr = createRun(defineSpot(config), { workers: 1, ...options });
			dcfr.step(5);
			const seed = dcfr.snapshot();
			dcfr.close();
			const js = createRun(defineSpot(config), { workers: 1, ...options, algorithm: 'cfr+', warmStart: seed });
			const engine = createRun(defineSpot(config), { workers: 1, ...options, algorithm: 'cfr+', warmStart: seed, wasmStorage });
			const regrets = (js.solver.ctx.compactRegret?.[0] ?? js.solver.ctx.regret) as ArrayLike<number>;
			expect(Array.prototype.some.call(regrets, (v: number) => v < 0)).toBe(true);
			js.step(1);
			engine.step(1);
			for (const [name, share] of compareStorage(js, engine)) expect(share, name).toBeLessThanOrEqual(0.02);
			js.close();
			engine.close();
		}
	});

	it('converges as JavaScript does, and threads change only float rounding', () => {
		for (const [config, options] of [
			[flop, { precision: 'i16' }],
			[{ ...flop, compactStorage: {} }, {}],
			[{ ...flop, compactStorage: { sums: false } }, { algorithm: 'cfr+' }],
		] as [SpotConfig, SolveOptions][]) {
			const results = [
				createRun(defineSpot(config), { workers: 1, ...options }),
				createRun(defineSpot(config), { workers: 1, ...options, wasmStorage }),
				createRun(defineSpot(config), { workers: 3, ...options, wasmStorage }),
			].map((run) => {
				run.step(40);
				const value = run.exploitabilityPercent();
				run.close();
				return value;
			});
			for (const value of results.slice(1)) expect(Math.abs(value - results[0])).toBeLessThan(0.15 * results[0] + 0.05);
		}
	});

	it('serves strategy queries, EVs and turn re-solves from its own storage', () => {
		const config: SpotConfig = { ...flop, compactStorage: { from: 1 } };
		const js = createRun(defineSpot(config), { workers: 1 });
		const run = createRun(defineSpot(config), { workers: 1, wasmStorage });
		js.step(30);
		run.step(30);
		const solution = run.snapshot();
		const { tree } = run.spot;
		const river = tree.decisionNodes.find((n) => tree.round[n] === 2)!;
		const probs = solution.strategyAt(river, 0).probs;
		expect(probs.every((p) => p >= 0 && p <= 1)).toBe(true);
		expect(Math.abs(solution.ev(0) - js.snapshot().ev(0))).toBeLessThan(0.05);
		// A turn re-solve, itself on the storage engine.
		let turnNode = -1;
		for (let node = 0; node < tree.nodeCount && turnNode < 0; node++) {
			if (tree.kind[node] === NodeKind.Chance && tree.round[node] === 0) turnNode = tree.edgeChild[tree.firstEdge[node]];
		}
		for (const precision of ['i16', 'f32'] as const) {
			const resolved = resolveSubgame(solution, turnNode, 0, {
				player: 0, iterations: 20, solve: { workers: 1, precision, wasmStorage },
			});
			expect(Number.isFinite(resolved.solution.ev(0))).toBe(true);
		}
		run.close();
		js.close();
	});
});

/** The turn spot's storage engine, laid out above `lowBytes`, on `threads` threads. */
function storageEngineFor(lowBytes: number, threads: number, quantised: boolean, compact: CompactPlan | null): Engine {
	const spot = defineSpot(turn);
	const relevant = new Uint8Array(COMBOS);
	for (const player of spot.players) for (const combo of player.combos) relevant[combo] = 1;
	const layout = buildLayout(spot.tree, spot.runouts, spot.players, quantised ? 2 : 4, undefined, false, compact ?? undefined);
	const showdown = buildShowdownTable(spot.runouts, relevant);
	const active = buildActiveLists(spot.runouts, spot.players, showdown);
	const hands = buildHandSpace(spot.runouts, spot.players, active);
	const plan = threads > 1 ? planShards(spot.tree, spot.runouts, threads)! : null;
	const engine = createEngine(
		{
			tree: spot.tree, runouts: spot.runouts, players: spot.players, layout, active, hands,
			runoutWeight: runoutWeights(spot.runouts), chipScale: spot.chipScale, lowBytes,
			storage: { source: wasmStorage, quantised, compact },
		},
		plan ? { plan, threads, spawn: spawnEngineWorker } : undefined,
	);
	if (!engine) throw new Error('The WebAssembly engine is not available here');
	if (engine.threads !== threads) throw new Error(`asked for ${threads} threads, got ${engine.threads}`);
	return engine;
}

/** A few training steps, an average read and the storage, as the solver runs them. */
function walk(engine: Engine): number[][] {
	const step = engine.root(true);
	const out: number[][] = [];
	try {
		for (let t = 1; t <= 3; t++) for (const player of [0, 1] as const) out.push(Array.from(step(Mode.Train, player, t)));
		out.push(Array.from(step(Mode.Average, 0, 0)));
		out.push(Array.from(engine.regret), Array.from(engine.strategySum));
		for (const chunk of engine.compact?.regret ?? []) out.push(Array.from(chunk));
		for (const chunk of engine.compact?.sum ?? []) out.push(Array.from(chunk));
	} finally {
		engine.close();
	}
	return out;
}

const PER_HAND: CompactPlan = { from: 1, steps: 127, perHand: true, stochastic: true, float: false, chunkBytes: 4096, sums: true };

describe.runIf(engineAvailable())('the storage engine with its storage past 2 GiB', () => {
	const HIGH = 2 ** 31 + 2 ** 20;
	for (const [label, quantised, compact] of [['i16', true, null], ['compact, in chunks', true, PER_HAND]] as const) {
		it(`solves as it does laid out low: ${label}`, () => {
			expect(walk(storageEngineFor(HIGH, 1, quantised, compact))).toEqual(walk(storageEngineFor(0, 1, quantised, compact)));
			expect(walk(storageEngineFor(HIGH, 3, quantised, compact))).toEqual(walk(storageEngineFor(0, 3, quantised, compact)));
		});
	}
});

describe('compactStorage combined with what it used to refuse (issue #84)', () => {
	const compactFlop: SpotConfig = { ...flop, compactStorage: {} };

	it('takes a precision for the rounds before compactStorage.from', () => {
		const run = createRun(defineSpot({ ...flop, compactStorage: { from: 1 } }), { workers: 1, precision: 'i16' });
		expect(run.solver.ctx.regret).toBeInstanceOf(Int16Array);
		expect(run.solver.ctx.layout.totalSlots).toBeGreaterThan(0);
		run.step(30);
		const full = createRun(defineSpot(flop), { workers: 1 });
		full.step(30);
		expect(run.exploitabilityPercent()).toBeLessThan(full.exploitabilityPercent() * 1.3 + 0.1);
		run.close();
		full.close();
	});

	it('runs compact storage over 16-bit rounds on JavaScript worker threads as on one', () => {
		const config: SpotConfig = { ...flop, compactStorage: { from: 1 } };
		const one = createRun(defineSpot(config), { workers: 1, precision: 'i16', engine: 'js' });
		const three = createRun(defineSpot(config), { workers: 3, precision: 'i16', engine: 'js' });
		one.step(8);
		three.step(8);
		expect(three.workers).toBe(3);
		for (const [name, share] of compareStorage(one, three)) expect(share, name).toBe(0);
		one.close();
		three.close();
	});

	it('runs compact storage with shared histories on JavaScript worker threads as on one', () => {
		// Each history's rounding stream is salted by its node (issue #88), never by thread or visit order.
		const config: SpotConfig = { ...flop, shareHistories: true, compactStorage: {} };
		const one = createRun(defineSpot(config), { workers: 1, engine: 'js' });
		const three = createRun(defineSpot(config), { workers: 3, engine: 'js' });
		one.step(8);
		three.step(8);
		expect(three.workers).toBe(3);
		expect(one.solver.ctx.layout.shared).toBe(true);
		for (const [name, share] of compareStorage(one, three)) {
			// Threads keep their discount marks in their own contexts, not this one.
			if (name !== 'discounted') expect(share, name).toBe(0);
		}
		one.close();
		three.close();
	});

	it('seeds a warm start, and starts warm, without losing the solve', () => {
		const source = createRun(defineSpot(compactFlop), { workers: 1 });
		source.step(30);
		const solved = source.exploitabilityPercent();
		// Into the same compact spot, averages and all, to the rounding of 8 bits.
		const resumed = createRun(defineSpot(compactFlop), { workers: 1, warmStart: source.snapshot() });
		expect(resumed.warmStart?.averages).toBe(true);
		expect(resumed.exploitabilityPercent()).toBeLessThan(solved * 1.1 + 0.02);
		// Into a 32-bit spot, and from there back into a compact one.
		const full = createRun(defineSpot(flop), { workers: 1, warmStart: source.snapshot() });
		const cold = createRun(defineSpot(flop), { workers: 1 });
		full.step(5);
		cold.step(5);
		expect(full.exploitabilityPercent()).toBeLessThan(cold.exploitabilityPercent());
		const back = createRun(defineSpot(compactFlop), { workers: 1, warmStart: full.snapshot(), warmIteration: 35 });
		const coldCompact = createRun(defineSpot(compactFlop), { workers: 1 });
		back.step(5);
		coldCompact.step(5);
		expect(back.exploitabilityPercent()).toBeLessThan(coldCompact.exploitabilityPercent());
		for (const run of [source, resumed, full, cold, back, coldCompact]) run.close();
	});

	it('carries a compact warm start without sums as its current profile', () => {
		const config: SpotConfig = { ...flop, compactStorage: { sums: false } };
		const source = createRun(defineSpot(config), { workers: 1 });
		source.step(20);
		const resumed = createRun(defineSpot(config), { workers: 1, warmStart: source.snapshot() });
		expect(Math.abs(resumed.exploitabilityPercent() - source.exploitabilityPercent())).toBeLessThan(0.1 * source.exploitabilityPercent());
		source.close();
		resumed.close();
	});

	it('runs a coarse start, on JavaScript and on the engine', () => {
		for (const options of [{}, { wasmStorage }] as SolveOptions[]) {
			const coarse = createRun(defineSpot(compactFlop), {
				workers: 1, ...options, approximations: { coarseStart: { iterations: 10, runoutBuckets: 3 } },
			});
			expect(coarse.warmStart?.matchedNodes).toBeGreaterThan(0);
			const cold = createRun(defineSpot(compactFlop), { workers: 1, ...options });
			coarse.step(5);
			cold.step(5);
			expect(coarse.exploitabilityPercent()).toBeLessThan(cold.exploitabilityPercent());
			coarse.close();
			cold.close();
		}
	});

	it('solves with runoutBuckets, and measures the real game', () => {
		for (const options of [{}, { wasmStorage }] as SolveOptions[]) {
			const config: SpotConfig = { ...compactFlop, runoutBuckets: 2 };
			const run = createRun(defineSpot(config), { workers: 1, ...options });
			expect(run.spot.runouts.approximate).toBe(true);
			run.step(30);
			const bucketed = run.exploitabilityPercent();
			const real = run.trueExploitabilityPercent();
			expect(Number.isFinite(real)).toBe(true);
			expect(real).toBeGreaterThanOrEqual(bucketed * 0.5);
			expect(real).toBeLessThan(10);
			run.close();
		}
	});

	it('runs chance sampling, on JavaScript and on the engine', () => {
		for (const options of [{}, { wasmStorage }] as SolveOptions[]) {
			const run = createRun(defineSpot(compactFlop), {
				workers: 1, ...options, approximations: { chanceSampling: { p: 0.5 } },
			});
			run.step(40);
			// Sampling has its own cost early on: held to 32-bit storage sampled alike.
			const full = createRun(defineSpot(flop), { workers: 1, approximations: { chanceSampling: { p: 0.5 } } });
			full.step(40);
			expect(run.exploitabilityPercent()).toBeLessThan(full.exploitabilityPercent() * 1.15 + 0.05);
			run.close();
			full.close();
		}
	});

	it('counts compact storage, not 32-bit, beside chance sampling\'s baselines', () => {
		const { bytes, compactBytes } = defineSpot(compactFlop).estimate;
		const maxBytes = Math.floor(bytes * 0.8);
		expect(compactBytes!).toBeLessThan(maxBytes);
		const run = createRun(defineSpot({ ...compactFlop, maxBytes }), {
			workers: 1, approximations: { chanceSampling: { p: 0.5 } },
		});
		run.step(2);
		run.close();
	});

	it('still refuses analysisOnly, which loads float32 sums', () => {
		expect(() => createRun(defineSpot(compactFlop), { workers: 1, analysisOnly: true })).toThrow(/compactStorage/);
	});
});
