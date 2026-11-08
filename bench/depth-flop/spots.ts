/**
 * The spots issue #48 measures: the round's target T and the smaller T₀, on
 * the bench flop and on a monotone one, with the bench ranges.
 */

import type { SpotConfig } from '../../src/index.ts';
import { SPOTS as COMPARE } from '../compare/spots.ts';

const ranges = { oop: COMPARE.flop.oop, ip: COMPARE.flop.ip, pot: 55, stack: 975 };

/** T: three sizes on every street, a 0.75 raise, three aggressions. */
export const T = { betSizes: [[0.33, 0.75, 1.5]], raiseSizes: [[0.75]], allowAllIn: true, maxRaises: 3 } as const;
/** T₀: three sizes, all-in the only raise, two aggressions. */
export const T0 = { betSizes: [[0.33, 0.75, 1.5]], raiseSizes: [['allin']], allowAllIn: true, maxRaises: 2 } as const;

export const BOARDS = { rainbow: 'As Kh 7d', monotone: 'Ks 9s 4s' } as const;

/** `<tree>-<board>`, e.g. `T-rainbow`. */
export const SPOTS: Record<string, SpotConfig> = {};
for (const [boardName, board] of Object.entries(BOARDS)) {
	SPOTS[`T-${boardName}`] = { board, ...ranges, ...T } as SpotConfig;
	SPOTS[`T0-${boardName}`] = { board, ...ranges, ...T0 } as SpotConfig;
}
