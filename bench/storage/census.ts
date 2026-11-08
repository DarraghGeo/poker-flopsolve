/**
 * Where storage sits: slots per betting round, and slots at decisions facing
 * an all-in (fold or call only), for issue #50's options 1 and 4.
 *
 *   node --import tsx bench/storage/census.ts [spot...]
 */

import { defineSpot } from '../../src/index.ts';
import { buildLayout } from '../../src/cfr.ts';
import { STORAGE_SPOTS } from './spots.ts';

const GiB = 2 ** 30;
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(STORAGE_SPOTS)) {
	const spot = defineSpot(STORAGE_SPOTS[name]);
	const { tree, runouts, players } = spot;
	const layout = buildLayout(tree, runouts, players, 4);
	const byRound = new Float64Array(runouts.rounds);
	let facingAllIn = 0;
	let hands = 0;
	const order = [...tree.decisionNodes].sort((a, b) => layout.offset[a] - layout.offset[b]);
	for (let k = 0; k < order.length; k++) {
		const node = order[k];
		const actions = tree.numEdges[node];
		const slots = (k + 1 < order.length ? layout.offset[order[k + 1]] : layout.totalSlots) - layout.offset[node];
		byRound[tree.round[node]] += slots;
		hands += slots / actions;
		if (actions === 2) facingAllIn += slots;
	}
	const total = layout.totalSlots;
	console.log(
		`${name}: ${tree.decisionNodes.length} decisions, ${(total / 1e6).toFixed(1)}M slots, ` +
			`f32 ${(spot.estimate.bytes / GiB).toFixed(2)} GiB, i16 ${(spot.estimate.compressedBytes / GiB).toFixed(2)} GiB; ` +
			`by round ${[...byRound].map((s) => ((100 * s) / total).toFixed(3) + '%').join(' / ')}; ` +
			`2-action nodes ${((100 * facingAllIn) / total).toFixed(1)}%; mean actions ${(total / hands).toFixed(2)}`,
	);
}
