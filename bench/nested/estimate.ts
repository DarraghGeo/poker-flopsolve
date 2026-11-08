/**
 * Storage of T, T₀ and blueprint variants, from `defineSpot(...).estimate`.
 *
 *   node --import tsx bench/nested/estimate.ts
 */
import { defineSpot } from '../../src/index.ts';
import type { SpotConfig } from '../../src/index.ts';
import { blueprint, small, target, type BoardName, type Later } from './spots.ts';

const MiB = 2 ** 20;
const row = (name: string, config: SpotConfig): void => {
	const spot = defineSpot(config);
	const e = spot.estimate;
	console.log(
		`${name.padEnd(46)} nodes ${String(e.decisionNodes).padStart(7)}  runouts ${e.runouts}  ` +
			`f32 ${(e.bytes / MiB).toFixed(0).padStart(6)} MiB  i16 ${(e.compressedBytes / MiB).toFixed(0).padStart(6)} MiB`,
	);
};

const variants: Record<string, Later> = {
	'1 size, no raise': { sizes: [0.75], maxRaises: 1 },
	'1 size + all-in, no raise': { sizes: [0.75], maxRaises: 1, allowAllIn: true },
	'1 size, all-in raise': { sizes: [0.75], maxRaises: 2, raise: 'allin' },
	'2 sizes, no raise': { sizes: [0.33, 1.5], maxRaises: 1 },
	'2 sizes, all-in raise': { sizes: [0.33, 1.5], maxRaises: 2, raise: 'allin' },
	'3 sizes, no raise': { sizes: [0.33, 0.75, 1.5], maxRaises: 1 },
	'3 sizes, all-in raise': { sizes: [0.33, 0.75, 1.5], maxRaises: 2, raise: 'allin' },
};

for (const board of ['rainbow', 'monotone'] as BoardName[]) {
	console.log(`\n== ${board}`);
	row('T', target(board));
	row('T0', small(board));
	for (const [full, make] of [['T', target], ['T0', small]] as const) {
		for (const [name, later] of Object.entries(variants)) {
			row(`B(${full}) ${name}`, blueprint(make(board), later));
			row(`B(${full}) ${name}, buckets 3`, { ...blueprint(make(board), later), runoutBuckets: 3 });
		}
	}
}
