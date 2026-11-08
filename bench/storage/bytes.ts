/**
 * Bytes each storage variant needs on a spot, from `defineSpot`'s estimate,
 * and per slot; plus what sub-byte packings would need, computed.
 *
 *   node --import tsx bench/storage/bytes.ts [spot...]
 */

import { defineSpot } from '../../src/index.ts';
import { buildLayout } from '../../src/cfr.ts';
import { STORAGE_SPOTS } from './spots.ts';

const GiB = 2 ** 30;
for (const name of process.argv.slice(2)) {
	const base = STORAGE_SPOTS[name];
	const spot = defineSpot(base);
	const { tree, runouts, players } = spot;
	const slots = spot.estimate.totalSlots;
	const showdown = spot.estimate.bytes - buildLayout(tree, runouts, players, 4).bytes;
	const perHand = buildLayout(tree, runouts, players, 4, { from: 0, steps: 127, perHand: true, stochastic: true, float: false, chunkBytes: 2 ** 30, sums: false });
	const hands = perHand.compactHands;
	const blocks = perHand.blocks;
	const rows: [string, number][] = [
		['f32', spot.estimate.bytes],
		['i16', spot.estimate.compressedBytes],
		['f32 regrets, no sums (option 1)', slots * 4 + showdown],
		['i16 regrets, no sums', slots * 2 + blocks * 8 + showdown],
		['i8, scale per hand, no sums', perHand.bytes + showdown],
		['i8, scale per block, no sums', slots + blocks * 8 + showdown],
		['i8, 4-bit scale per hand (computed)', slots + hands / 2 + blocks * 8 + showdown],
		['i6 packed, 4-bit scale per hand (computed)', slots * 0.75 + hands / 2 + blocks * 8 + showdown],
		['i4 packed, 4-bit scale per hand (computed)', slots * 0.5 + hands / 2 + blocks * 8 + showdown],
	];
	console.log(`${name}: ${(slots / 1e6).toFixed(0)}M slots, ${(hands / 1e6).toFixed(0)}M hand rows, ${(blocks / 1e6).toFixed(2)}M blocks, showdown ${(showdown / 2 ** 20).toFixed(0)} MiB`);
	for (const [label, bytes] of rows) {
		console.log(`  ${label.padEnd(44)} ${(bytes / GiB).toFixed(2)} GiB  ${(bytes / slots).toFixed(2)} B/slot`);
	}
}
