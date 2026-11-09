/**
 * Storage census of issue #47's blueprint under `shareHistories` (issue #85,
 * step 1). No solving.
 *
 *   node --import tsx bench/blueprint-share/census.ts
 *
 * The blueprint is `bench/nested`'s `1size`: T's flop betting (0.33, 0.75 and
 * 1.5 pot, a 0.75 raise, all-in, three aggressions) and one 0.75 bet on the
 * turn and river with no raise. Each row is `defineSpot(...).estimate`: f32
 * is what the WebAssembly engine holds, i16 the JavaScript engine's 16-bit
 * storage. "river" is `shareHistories: true`; "turn+river" is
 * `{ fromRound: 1 }`.
 */

import { defineSpot } from '../../src/index.ts';
import type { SpotConfig } from '../../src/index.ts';
import { blueprint, target } from '../nested/spots.ts';

const BOARDS = { rainbow: 'As Kh 7d', monotone: 'Ks 9s 4s', 'two-tone': 'Ts 9s 4h' } as const;
const MiB = 2 ** 20;
const SHARES: Record<string, SpotConfig['shareHistories']> = {
	none: undefined,
	river: true,
	'turn+river': { fromRound: 1 },
};

console.log('| board | buckets | share | f32 MiB | i16 MiB | saving | turn nodes → owners | river nodes → owners |');
console.log('|---|---|---|---|---|---|---|---|');
for (const [name, board] of Object.entries(BOARDS)) {
	for (const buckets of [false, 3] as const) {
		let base = 0;
		for (const [label, share] of Object.entries(SHARES)) {
			const config: SpotConfig = {
				...blueprint({ ...target('rainbow'), board }, { sizes: [0.75], maxRaises: 1 }),
				...(buckets ? { runoutBuckets: buckets } : {}),
				...(share !== undefined ? { shareHistories: share } : {}),
			};
			const spot = defineSpot(config);
			const e = spot.estimate;
			if (share === undefined) base = e.bytes;
			const alias = spot.historyAlias;
			// Decision nodes per round, and how many own storage.
			const { tree } = spot;
			const all = [0, 0, 0];
			const own = [0, 0, 0];
			for (const node of tree.decisionNodes) {
				all[tree.round[node]]++;
				if (!alias || alias[node] === node) own[tree.round[node]]++;
			}
			console.log(
				`| ${name} | ${buckets || 'off'} | ${label} | ${(e.bytes / MiB).toFixed(0)} | ${(e.compressedBytes / MiB).toFixed(0)} | ` +
					`${(base / e.bytes).toFixed(2)}× | ${all[1]} → ${own[1]} | ${all[2]} → ${own[2]} |`,
			);
		}
	}
}
