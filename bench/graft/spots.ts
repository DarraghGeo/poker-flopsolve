/**
 * The spots issue #56 measures: the round's target T on two flops, and R,
 * the game flop-only grafting approximates — T's three sizes on the flop's
 * opening bet, the base size (0.75) on the turn's and the river's.
 */

import type { SpotConfig } from '../../src/index.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';

/** The flop opening-bet sizes grafted, and the size every other opening bet uses. */
export const SIZES = [0.33, 0.75, 1.5] as const;
export const BASE = 0.75;

export const BOARDS: Record<string, string> = { rainbow: 'As Kh 7d', monotone: 'Ks 9s 4s' };

const common = {
	pot: 55, stack: 975, oop: OOP, ip: IP,
	raiseSizes: [[0.75]], allowAllIn: true, maxRaises: 3, maxBytes: 2 ** 40,
} as const;

/** T: three sizes on every street. */
export const target = (board: string): SpotConfig =>
	({ ...common, board, betSizes: [[...SIZES]] }) as unknown as SpotConfig;

/** R: three sizes on the flop's opening bet, the base size after it. */
export const flopGame = (board: string): SpotConfig =>
	({ ...common, board, betSizes: [[...SIZES], [BASE], [BASE]] }) as unknown as SpotConfig;

/** One size everywhere: the blueprint. */
export const baseGame = (board: string): SpotConfig =>
	({ ...common, board, betSizes: [[BASE]] }) as unknown as SpotConfig;
