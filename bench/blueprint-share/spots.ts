/**
 * Boards and the blueprint measured for issue #85: `bench/nested`'s
 * `1size-b3` (T's flop betting, one 0.75 turn and river bet with no raise,
 * `runoutBuckets: 3`), on a rainbow, a two-tone and a monotone flop.
 */

import type { SpotConfig } from '../../src/index.ts';
import { blueprint as simplify, target } from '../nested/spots.ts';

export const BOARDS = { rainbow: 'As Kh 7d', 'two-tone': 'Ts 9s 4h', monotone: 'Ks 9s 4s' } as const;
export type Board = keyof typeof BOARDS;

/** Turns sampled for re-solves: a blank, a broadway card, a pairing or flush card. */
export const TURNS: Record<Board, readonly string[]> = {
	rainbow: ['2c', 'Qs', '7c'],
	'two-tone': ['2c', 'Qd', 'As'],
	monotone: ['2h', 'Qd', 'As'],
};

export const SHARES: Record<string, SpotConfig['shareHistories']> = {
	none: undefined,
	river: true,
	'turn+river': { fromRound: 1 },
};

/** The full tree T on `board`. */
export function full(board: Board): SpotConfig {
	if (!(board in BOARDS)) throw new Error(`board must be one of ${Object.keys(BOARDS)}`);
	return { ...target('rainbow'), board: BOARDS[board] };
}

/** The blueprint on `board` with the named sharing. */
export function blueprintOf(board: Board, shareName: string): SpotConfig {
	if (!(shareName in SHARES)) throw new Error(`share must be one of ${Object.keys(SHARES)}`);
	const share = SHARES[shareName];
	return {
		...simplify(full(board), { sizes: [0.75], maxRaises: 1 }),
		runoutBuckets: 3,
		...(share !== undefined ? { shareHistories: share } : {}),
	};
}
