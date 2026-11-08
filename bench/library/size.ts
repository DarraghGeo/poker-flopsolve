/**
 * How big a flop-library entry is, per street of the tree it seeds (#30).
 *
 *   node --import tsx bench/library/size.ts
 *
 * Counts the accumulator slots (one per action per live hand per stored
 * board) that the decisions of each round hold, and turns them into bytes at
 * one byte per slot, the planned quantisation. Root EVs are two bytes per
 * combination per player.
 */

import { createRun, defineSpot } from '../../src/index.ts';
import { SPOTS } from './spots.ts';

const BYTES_PER_SLOT = 1;
const BYTES_PER_EV = 2;

console.log('spot        flop slots   turn slots   river slots   EV bytes   flop KB   flop+turn MB   all MB');
for (const [name, { config }] of Object.entries(SPOTS)) {
	const spot = defineSpot(config);
	const run = createRun(spot, { analysisOnly: true });
	const { tree, active, runouts } = run.solver.ctx;
	const slots = [0, 0, 0];
	for (const node of tree.decisionNodes) {
		const round = tree.round[node];
		const owner = tree.player[node];
		for (let board = 0; board < runouts.counts[round]; board++) {
			slots[round] += tree.numEdges[node] * active.count[(active.roundBase[round] + board) * 2 + owner];
		}
	}
	run.close();
	const ev = (spot.players[0].count + spot.players[1].count) * BYTES_PER_EV;
	console.log(
		`${name.padEnd(10)}${String(slots[0]).padStart(12)}${String(slots[1]).padStart(13)}${String(slots[2]).padStart(14)}` +
			`${String(ev).padStart(11)}${((slots[0] * BYTES_PER_SLOT + ev) / 1024).toFixed(1).padStart(10)}` +
			`${(((slots[0] + slots[1]) * BYTES_PER_SLOT + ev) / 1e6).toFixed(2).padStart(15)}` +
			`${(((slots[0] + slots[1] + slots[2]) * BYTES_PER_SLOT + ev) / 1e6).toFixed(1).padStart(9)}`,
	);
}
