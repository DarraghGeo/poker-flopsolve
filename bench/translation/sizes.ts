/**
 * Experiment 1b of issue #54: T's storage with raises solved only over some
 * bet sizes (`raiseOver`), the rest translated.
 *
 *   node --import tsx bench/translation/sizes.ts
 */
import { defineSpot, type SpotConfig } from '../../src/index.ts';
import { targetSpot } from './spots.ts';

const gib = (b: number): string => `${(b / 2 ** 30).toFixed(2)} GiB`;
const variants: [string, Partial<SpotConfig>][] = [
	['T (raises over every bet)', {}],
	['raises over 0.75 only', { raiseOver: [0.75] }],
	['raises over 0.75 and 1.5', { raiseOver: [0.75, 1.5] }],
	['raises over 0.33 only', { raiseOver: [0.33] }],
	['raises over 1.5 only', { raiseOver: [1.5] }],
	['shove only (raiseOver: [])', { raiseOver: [] }],
	['T0: all-in-only raise, 2 aggressions', { raiseSizes: [['allin']], maxRaises: 2 }],
	['3 sizes, no raise', { allowAllIn: false, maxRaises: 1 }],
];
for (const board of ['As Kh 7d', 'Ks 9s 4s']) {
	console.log(`\n${board}`);
	for (const [name, extra] of variants) {
		const e = defineSpot({ ...targetSpot(board), ...extra, maxBytes: 2 ** 40 }).estimate;
		console.log(`${name.padEnd(40)} f32 ${gib(e.bytes).padStart(10)}  i16 ${gib(e.compressedBytes).padStart(10)}  nodes ${e.decisionNodes}`);
	}
}
