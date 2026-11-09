/**
 * Storage each `lineRunouts` rule leaves (issue #53), before any solving: the
 * spot's own estimate, so it is exactly what a solve would allocate.
 *
 *   node --import tsx bench/history-runouts/plan.ts [--spot T,M] [--buckets 3]
 *
 * With `--buckets g`, every row also has `runoutBuckets: g`, which stacks.
 */

import { defineSpot } from '../../src/index.ts';
import type { LineRunouts } from '../../src/index.ts';
import { SPOTS } from './spots.ts';

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string): string | undefined => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : fallback;
};
const buckets = opt('buckets') ? { runoutBuckets: Number(opt('buckets')) } : {};
const gib = (bytes: number): string => `${(bytes / 2 ** 30).toFixed(2)} GiB`;

const rules: (LineRunouts | null)[] = [null];
for (const band of [1, 3, 13]) {
	for (const rule of [{ raises: 1 }, { raises: 2 }, { aggressions: 2 }, { aggressions: 3 }, { aggressions: 0 }]) rules.push({ ...rule, band });
}

for (const name of opt('spot', 'T,M')!.split(',')) {
	console.log(`\n${name} ${SPOTS[name].board}${opt('buckets') ? `, runoutBuckets ${opt('buckets')}` : ''}`);
	for (const rule of rules) {
		const spot = defineSpot({ ...SPOTS[name], ...buckets, maxBytes: 2 ** 40, ...(rule ? { lineRunouts: rule } : {}) });
		const label = rule ? JSON.stringify(rule) : 'exact';
		console.log(
			`  ${label.padEnd(30)} boards ${spot.runouts.counts.join('/').padEnd(14)} ` +
				`f32 ${gib(spot.estimate.bytes).padStart(10)}  i16 ${gib(spot.estimate.compressedBytes).padStart(10)}`,
		);
	}
}
