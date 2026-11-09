/**
 * Issue #102: projected storage of each combination of memory levers on a
 * spot, from `Spot.estimate` alone (no solve).
 *
 *   node --import tsx bench/combos/census.ts <spot> <combination>...
 *
 * Prints, per combination, decision nodes, stored runouts and storage at
 * 32 bits, 16 bits and compact (8-bit with sums), GiB.
 */

import { defineSpot } from '../../src/index.ts';
import { combination, SPOTS } from './spots.ts';

const [spotName, ...names] = process.argv.slice(2);
const GiB = 2 ** 30;
for (const name of names) {
	const { config } = combination(name);
	// The census asks for compact bytes whatever the combination says.
	const spot = defineSpot({ ...SPOTS[spotName], ...config, compactStorage: {} });
	const e = spot.estimate;
	console.log(
		`${spotName} ${name.padEnd(16)} nodes ${String(e.decisionNodes).padStart(6)}  runouts ${String(e.runouts).padStart(6)}  ` +
			`f32 ${(e.bytes / GiB).toFixed(2)}  i16 ${(e.compressedBytes / GiB).toFixed(2)}  compact ${((e.compactBytes ?? 0) / GiB).toFixed(2)}`,
	);
}
