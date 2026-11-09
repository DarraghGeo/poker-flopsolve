/**
 * Spots for issue #50 (storage compression): the round's target T and its
 * smaller sibling T₀, on the bench flop and the monotone one, plus the small
 * bench flops for quick iteration.
 */

import type { SpotConfig } from '../../src/index.ts';
import { SPOTS } from '../compare/spots.ts';

const ranges = { oop: SPOTS.flop.oop, ip: SPOTS.flop.ip };

const target = (board: string, tree: Partial<SpotConfig>): SpotConfig =>
	({
		board, pot: 55, stack: 975, ...ranges,
		betSizes: [[0.33, 0.75, 1.5]], allowAllIn: true, maxBytes: 64 * 2 ** 30, ...tree,
	}) as SpotConfig;

/** T: three sizes, a 75% raise, three aggressions. */
const T = { raiseSizes: [[0.75]], maxRaises: 3 } as Partial<SpotConfig>;
/** T₀: three sizes, all-in as the only raise, two aggressions. */
const T0 = { raiseSizes: ['allin'], maxRaises: 2, allowAllIn: false } as Partial<SpotConfig>;

export const STORAGE_SPOTS: Record<string, SpotConfig> = {
	flop: { ...SPOTS.flop, maxBytes: 64 * 2 ** 30 },
	monotone: { ...SPOTS.monotone, maxBytes: 64 * 2 ** 30 },
	turn: { ...SPOTS.turn, maxBytes: 64 * 2 ** 30 },
	T0: target('As Kh 7d', T0),
	T0mono: target('Ks 9s 4s', T0),
	T: target('As Kh 7d', T),
	Tmono: target('Ks 9s 4s', T),
};
