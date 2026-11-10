/**
 * Threaded solves with a thread made to fail mid-iteration, for
 * thread-failure.test.ts and the browser checks in browser-threads.test.ts.
 *
 * Each thread starts as usual and then fails in its first step, from a setup
 * altered on its way to the thread: nothing in the solver itself is faked.
 */

import { COMBOS } from '../src/cards.ts';
import type { Context } from '../src/cfr.ts';
import { buildActiveLists, buildLayout, makeSolver, makeTerminalScratch, matchupMass, runoutWeights } from '../src/cfr.ts';
import type { Engine, SpawnEngineWorker } from '../src/engine.ts';
import { createEngine, ENGINE_CONTROL } from '../src/engine.ts';
import { buildHandSpace } from '../src/hands.ts';
import type { SpotConfig } from '../src/index.ts';
import { defineSpot, makeRegretStore, makeSumStore } from '../src/index.ts';
import type { Pool, SpawnWorker } from '../src/parallel.ts';
import { CONTROL, planShards, startPool } from '../src/parallel.ts';
import { buildShowdownTable } from '../src/showdown.ts';

const config: SpotConfig = {
	board: 'AsKh7d2c', pot: 60, stack: 120,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};

/** A turn spot laid out as `createRun` lays it out, split across `threads`. */
function prepare(threads: number, shared: boolean) {
	const spot = defineSpot(config);
	const relevant = new Uint8Array(COMBOS);
	for (const player of spot.players) for (const combo of player.combos) relevant[combo] = 1;
	const layout = buildLayout(spot.tree, spot.runouts, spot.players, 4);
	const showdown = buildShowdownTable(spot.runouts, relevant);
	const active = buildActiveLists(spot.runouts, spot.players, showdown);
	const hands = buildHandSpace(spot.runouts, spot.players, active);
	const weights = runoutWeights(spot.runouts);
	const plan = planShards(spot.tree, spot.runouts, threads)!;
	const allocate = (bytes: number) => (shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
	const ctx: Context = {
		tree: spot.tree, runouts: spot.runouts, players: spot.players, layout, showdown,
		regret: makeRegretStore('f32', allocate(layout.totalSlots * 4)),
		strategySum: makeSumStore('f32', allocate(layout.totalSlots * 4)),
		regretScale: null, sumScale: null, scratch: makeTerminalScratch(), chipScale: spot.chipScale,
		active, hands, runoutWeight: weights,
		totalMass: matchupMass(spot.players[0].weights, spot.players[1].weights) * weights[0],
		dcfr: true, shardStart: 0, shardEnd: plan.boards, shardRound: plan.round, applyUpdates: true,
		chanceCollect: null, chanceOverride: null, entryIndexOf: plan.entryIndexOf, expandOrbits: false, simd: true,
	};
	return { spot, plan, ctx };
}

/**
 * A stand-in for the engine module whose exports do nothing, except that
 * `setPhase` traps (`unreachable`) from its second call on. The first call
 * is in the thread's start-up, so the thread gets ready as usual; the next is
 * the first thing its part of each step does, inside the walk's `try`.
 *
 * The trap must come before the thread takes a board. Threads take boards
 * off a shared counter that the main thread takes from as well, so a thread
 * that wakes late may find none left. A fault that waits for a board
 * (`runChance`) then never fires, and the step succeeds.
 *
 * A trap stands in for the likelier real fault, an out-of-bounds access,
 * because headless Chromium in some sandboxes crashes the whole page on one
 * rather than throwing.
 */
function trappingEngine(): unknown {
	const names = ['init', 'setMaxActions', 'setExchange', 'setShard', 'setPhase', 'runChance'];
	const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
	const section = (id: number, body: number[]) => [id, body.length, ...body];
	const exports = names.flatMap((name, i) => [name.length, ...ascii(name), 0, i]);
	// calls += 1; if (calls > 1) unreachable
	const trapAfterFirst = [
		0x00, // no locals
		0x23, 0, 0x41, 1, 0x6a, 0x24, 0, // global 0 += 1
		0x23, 0, 0x41, 1, 0x4a, // global 0 > 1
		0x04, 0x40, 0x00, 0x0b, // if: unreachable
		0x0b,
	];
	// Every function is () -> (); calls from JavaScript may pass arguments all the same.
	const bodies = names.flatMap((name) => (name === 'setPhase' ? [trapAfterFirst.length, ...trapAfterFirst] : [2, 0, 0x0b]));
	const bytes = Uint8Array.from([
		0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
		...section(1, [1, 0x60, 0, 0]),
		...section(3, [names.length, ...names.map(() => 0)]),
		// One mutable i32, starting at 0: how many times `setPhase` has run.
		...section(6, [1, 0x7f, 1, 0x41, 0, 0x0b]),
		...section(7, [names.length, ...exports]),
		...section(10, [names.length, ...bodies]),
	]);
	const api = (globalThis as unknown as { WebAssembly: { Module: new (bytes: Uint8Array) => unknown } }).WebAssembly;
	return new api.Module(bytes);
}

/**
 * A threaded WebAssembly engine whose spawned threads trap in their first step,
 * whether or not they get a board to walk.
 * @param spawn the platform's `spawnEngineWorker`
 * @param threads threads, this one included
 */
export function brokenEngine(spawn: SpawnEngineWorker, threads = 2): Engine {
	const { spot, plan, ctx } = prepare(threads, false);
	const engine = createEngine(
		{
			tree: spot.tree, runouts: spot.runouts, players: spot.players, layout: ctx.layout, active: ctx.active,
			hands: ctx.hands, runoutWeight: ctx.runoutWeight, chipScale: spot.chipScale,
		},
		{
			plan, threads,
			spawn: (setup, onError) => spawn({ ...setup, module: trappingEngine() }, onError),
		},
	);
	if (!engine) throw new Error('The WebAssembly engine is not available here');
	return engine;
}

/**
 * A JavaScript worker pool whose workers throw on their first walk: every
 * entry node lies past the end of the tree.
 * @param spawn the platform's `spawnWorker`
 * @param threads threads, this one included
 */
export function brokenPool(spawn: SpawnWorker, threads = 2): Pool {
	const { spot, plan, ctx } = prepare(threads, true);
	const payload = { config: spot.source, dcfr: true, precision: 'f32', simd: true };
	return startPool(ctx, makeSolver(ctx), plan, payload, threads, (setup, onError) =>
		spawn({ ...setup, plan: { ...setup.plan, entryNodes: setup.plan.entryNodes.map(() => 1 << 30) } }, onError),
	);
}

/**
 * A spawn that starts a thread which says it is ready and then never runs
 * again: no `done`, no `failed` and no event the waiting main thread could
 * see, which is how a thread looks once it is killed without unwinding (a
 * Node worker out of V8 heap, a browser-killed worker).
 * @param control the setup's control buffer
 * @param ready that buffer's `ready` slot
 */
function vanish(control: SharedArrayBuffer, ready: number): { terminate(): void } {
	const slots = new Int32Array(control);
	Atomics.add(slots, ready, 1);
	Atomics.notify(slots, ready);
	return { terminate() {} };
}

/**
 * A threaded WebAssembly engine whose last spawned thread vanishes once ready.
 * @param spawn the platform's `spawnEngineWorker`
 * @param threads threads, this one included
 * @param backstopFloorMs the shortest the main thread waits for the others
 */
export function vanishingEngine(spawn: SpawnEngineWorker, threads: number, backstopFloorMs: number): Engine {
	const { spot, plan, ctx } = prepare(threads, false);
	let spawned = 0;
	const engine = createEngine(
		{
			tree: spot.tree, runouts: spot.runouts, players: spot.players, layout: ctx.layout, active: ctx.active,
			hands: ctx.hands, runoutWeight: ctx.runoutWeight, chipScale: spot.chipScale,
		},
		{
			plan, threads, backstopFloorMs,
			spawn: (setup, onError) => (++spawned === threads - 1 ? vanish(setup.control, ENGINE_CONTROL.ready) : spawn(setup, onError)),
		},
	);
	if (!engine) throw new Error('The WebAssembly engine is not available here');
	return engine;
}

/**
 * A JavaScript worker pool whose last spawned worker vanishes once ready.
 * @param spawn the platform's `spawnWorker`
 * @param threads threads, this one included
 * @param backstopFloorMs the shortest the main thread waits for the others
 */
export function vanishingPool(spawn: SpawnWorker, threads: number, backstopFloorMs: number): Pool {
	const { spot, plan, ctx } = prepare(threads, true);
	const payload = { config: spot.source, dcfr: true, precision: 'f32', simd: true };
	return startPool(
		ctx, makeSolver(ctx), plan, payload, threads,
		(setup, onError) => (setup.workerId === threads - 2 ? vanish(setup.control, CONTROL.ready) : spawn(setup, onError)),
		backstopFloorMs,
	);
}
