/**
 * The spots issue #51 measures: the round's target T and its cut-down T₀ on
 * the bench rainbow and monotone flops, and the budgeted trees built from T.
 */

import type { SpotConfig } from '../../src/index.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';

export const BOARDS = { rainbow: 'As Kh 7d', monotone: 'Ks 9s 4s', turn: 'As Kh 7d 2c' } as const;
export type BoardName = keyof typeof BOARDS;

export const THREE = [0.33, 0.75, 1.5] as const;

/** T: three sizes everywhere, a 0.75 raise and a shove, three aggressions a round. */
export const T_BETTING = {
	betSizes: [[...THREE]],
	raiseSizes: [[0.75]],
	allowAllIn: true,
	maxRaises: 3,
} as const satisfies Partial<SpotConfig>;

/** T₀: three sizes, a shove as the only raise, two aggressions a round. */
export const T0_BETTING = {
	betSizes: [[...THREE]],
	raiseSizes: ['allin'],
	allowAllIn: true,
	maxRaises: 2,
} as const satisfies Partial<SpotConfig>;

/** A spot on one of the two boards, any betting; no memory ceiling. */
export function spotOn(board: BoardName, betting: Partial<SpotConfig>): SpotConfig {
	return {
		board: BOARDS[board],
		pot: 55,
		stack: 975,
		oop: OOP,
		ip: IP,
		maxBytes: 2 ** 50,
		...betting,
	} as SpotConfig;
}
