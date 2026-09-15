/**
 * Solver worker.
 *
 * Purpose: traverse one shard of the runout space.
 *
 * A worker owns a contiguous range of runouts at the split round. Because
 * storage is indexed runout-outermost, everything it writes below that round is
 * its own; nothing is shared and nothing is locked. It never visits a node above
 * the split, so the non-linear CFR+ clamp there stays the main thread's job.
 *
 * The spot is rebuilt from its config rather than shipped across as typed
 * arrays: `defineSpot` is deterministic, so both sides derive byte-identical
 * structures, and only the two accumulators are actually shared.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { COMBOS } from './cards.ts';
import type { Context } from './cfr.ts';
import {
	buildActiveLists,
	buildLayout,
	makeSolver,
	makeTerminalScratch,
	matchupMass,
	runoutWeights,
} from './cfr.ts';
import { defineSpot } from './index.ts';
import type { SpotConfig } from './index.ts';
import { buildShowdownTable } from './showdown.ts';
import type { WorkerSetup } from './parallel.ts';
import { COMMAND, CONTROL } from './parallel.ts';

const setup = workerData as WorkerSetup;
const { config } = setup.payload as { config: SpotConfig };

const spot = defineSpot(config);
const relevant = new Uint8Array(COMBOS);
for (const combo of spot.players[0].combos) relevant[combo] = 1;
for (const combo of spot.players[1].combos) relevant[combo] = 1;

const weights = runoutWeights(spot.runouts);
const layout = buildLayout(spot.tree, spot.runouts, spot.players, setup.float64 ? 8 : 4);

const ctx: Context = {
	tree: spot.tree,
	runouts: spot.runouts,
	players: spot.players,
	layout,
	showdown: buildShowdownTable(spot.runouts, relevant),
	regret: setup.float64 ? new Float64Array(setup.regret) : new Float32Array(setup.regret),
	strategySum: setup.float64
		? new Float64Array(setup.strategySum)
		: new Float32Array(setup.strategySum),
	scratch: makeTerminalScratch(),
	chipScale: spot.chipScale,
	active: buildActiveLists(spot.runouts, spot.players),
	runoutWeight: weights,
	totalMass: matchupMass(spot.players[0].weights, spot.players[1].weights) * weights[0],
	shardStart: setup.shardStart,
	shardEnd: setup.shardEnd,
	shardRound: setup.plan.round,
	applyUpdates: true,
	chanceCollect: null,
	chanceOverride: null,
	entryIndexOf: null,
};

const solver = makeSolver(ctx);
const control = new Int32Array(setup.control);
const exchange = new Float64Array(setup.exchange);
const reachFloats = setup.entryCount * 2 * COMBOS;
const partialBase = reachFloats + setup.workerId * setup.entryCount * COMBOS;

const reachMe = new Float64Array(COMBOS);
const reachOpp = new Float64Array(COMBOS);

// Latch the generation BEFORE announcing readiness, so no dispatch that happens
// after this point can be missed.
let generation = Atomics.load(control, CONTROL.generation);
Atomics.add(control, CONTROL.ready, 1);
Atomics.notify(control, CONTROL.ready);

for (;;) {
	Atomics.wait(control, CONTROL.generation, generation);
	generation = Atomics.load(control, CONTROL.generation);
	if (Atomics.load(control, CONTROL.command) === COMMAND.exit) break;

	const traverser = Atomics.load(control, CONTROL.traverser) as 0 | 1;
	const iterWeight = Atomics.load(control, CONTROL.iterWeight);

	for (let entry = 0; entry < setup.plan.entryNodes.length; entry++) {
		const node = setup.plan.entryNodes[entry];
		for (let i = 0; i < COMBOS; i++) {
			reachMe[i] = exchange[entry * 2 * COMBOS + i];
			reachOpp[i] = exchange[entry * 2 * COMBOS + COMBOS + i];
		}
		const value = solver.traverseChance(traverser, iterWeight, node, reachMe, reachOpp);
		for (let i = 0; i < COMBOS; i++) exchange[partialBase + entry * COMBOS + i] = value[i];
	}

	Atomics.add(control, CONTROL.done, 1);
	Atomics.notify(control, CONTROL.done);
}

parentPort?.close();
