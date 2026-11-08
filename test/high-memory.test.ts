/**
 * The WebAssembly engine with its storage past 2 GiB (#62).
 *
 * wasm32 addresses 4 GiB, but a pointer the engine returns arrives in
 * JavaScript as a signed 32-bit integer, so one past 2 GiB came back
 * negative and the first step threw. Rather than build a 2–4 GiB tree, these
 * tests lay a small spot out above 2 GiB of unused memory (`lowBytes`), so
 * every pointer is a high one, and hold the result to the same spot laid out
 * low.
 */

import { describe, expect, it } from 'vitest';
import { COMBOS } from '../src/cards.ts';
import { buildActiveLists, buildLayout, Mode, runoutWeights } from '../src/cfr.ts';
import type { Engine } from '../src/engine.ts';
import { createEngine, engineAvailable } from '../src/engine.ts';
import { buildHandSpace } from '../src/hands.ts';
import type { SpotConfig } from '../src/index.ts';
import { defineSpot } from '../src/index.ts';
import { planShards } from '../src/parallel.ts';
import { spawnEngineWorker } from '../src/platform/node.ts';
import { buildShowdownTable } from '../src/showdown.ts';

const config: SpotConfig = {
	board: 'AsKh7d2c', pot: 60, stack: 120,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};

const HIGH = 2 ** 31 + 2 ** 20;

/** The turn spot's engine, laid out above `lowBytes`, on `threads` threads. */
function engineFor(lowBytes: number, threads: number): Engine {
	const spot = defineSpot(config);
	const relevant = new Uint8Array(COMBOS);
	for (const player of spot.players) for (const combo of player.combos) relevant[combo] = 1;
	const layout = buildLayout(spot.tree, spot.runouts, spot.players, 4);
	const showdown = buildShowdownTable(spot.runouts, relevant);
	const active = buildActiveLists(spot.runouts, spot.players, showdown);
	const hands = buildHandSpace(spot.runouts, spot.players, active);
	const plan = threads > 1 ? planShards(spot.tree, spot.runouts, threads)! : null;
	const engine = createEngine(
		{
			tree: spot.tree, runouts: spot.runouts, players: spot.players, layout, active, hands,
			runoutWeight: runoutWeights(spot.runouts), chipScale: spot.chipScale, lowBytes,
		},
		plan ? { plan, threads, spawn: spawnEngineWorker } : undefined,
	);
	if (!engine) throw new Error('The WebAssembly engine is not available here');
	// A spot that could not be split would quietly run on one thread.
	if (engine.threads !== threads) throw new Error(`asked for ${threads} threads, got ${engine.threads}`);
	return engine;
}

/** A few training steps and a current-profile read, as the solver runs them. */
function walk(engine: Engine): number[][] {
	const step = engine.root(true);
	const out: number[][] = [];
	try {
		for (let t = 1; t <= 3; t++) for (const player of [0, 1] as const) out.push(Array.from(step(Mode.Train, player, t)));
		out.push(Array.from(step(Mode.Current, 0, 3)));
		out.push([engine.regret[0], engine.strategySum[engine.strategySum.length - 1]]);
	} finally {
		engine.close();
	}
	return out;
}

describe.runIf(engineAvailable())('the engine with storage past 2 GiB', () => {
	it('solves single-threaded as it does laid out low', () => {
		expect(walk(engineFor(HIGH, 1))).toEqual(walk(engineFor(0, 1)));
	});

	it('solves on threads as it does laid out low', () => {
		expect(walk(engineFor(HIGH, 3))).toEqual(walk(engineFor(0, 3)));
	});

	it('still refuses a layout that would pass 4 GiB', () => {
		expect(() => engineFor(0xffff0000, 1)).toThrow(/not available/);
	});
});
