/** Check `treeBytes` against `defineSpot(...).estimate` for the starting trees. */
import { defineSpot } from '../../src/index.ts';
import { baseKept, budgetedConfig, cutsFor, indexFull, lineBytes, treeBytes } from './grow.ts';
import { spotOn } from './spots.ts';
import { TREES } from './trees.ts';

const GiB = 2 ** 30;
for (const name of ['T', 'T0']) {
	const full = indexFull(spotOn('rainbow', TREES[name]));
	const kept = baseKept(full);
	const config = budgetedConfig(full, kept);
	const spot = defineSpot(config);
	const cuts = cutsFor(full, kept);
	console.log(name, 'base', (treeBytes(full, kept) / GiB).toFixed(3), 'estimate', (spot.estimate.bytes / GiB).toFixed(3), 'cuts', cuts.length);
	const one = cuts[0];
	const added = new Set(kept).add(one);
	const est = defineSpot(budgetedConfig(full, added)).estimate.bytes;
	console.log('  +', one, (lineBytes(full, kept, one) / 2 ** 20).toFixed(1), 'MiB; estimate diff', ((est - spot.estimate.bytes) / 2 ** 20).toFixed(1));
	const all = new Set(full.byPath.keys());
	console.log('  all kept', (treeBytes(full, all) / GiB).toFixed(3), 'full estimate', (defineSpot(full.config).estimate.bytes / GiB).toFixed(3));
}
