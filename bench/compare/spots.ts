/**
 * The spots `npm run bench:compare` measures, poker-flopsolve's side.
 *
 * The postflop-solver side (rust/src/main.rs) builds the same ones: same
 * boards and ranges, pot 100 and stack 200 (it scales by 100 so integer chips
 * round like a hundredth of one), bets as pot fractions, and all-in as the
 * only raise — postflop-solver has no raise cap, so an all-in-only raise is
 * how the two trees are made to match. Keep the two lists in step.
 */

import type { SpotConfig } from '../../src/index.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const raise = { betSizes: [[0.25, 0.75]], raiseSizes: ['allin'] as const, maxRaises: 2 };
const noRaise = { betSizes: [[0.5]], maxRaises: 1 };

const spot = (board: string, tree: Partial<SpotConfig>): SpotConfig =>
	({ board, pot: 100, stack: 200, oop: OOP, ip: IP, ...tree }) as SpotConfig;

export const SPOTS: Record<string, SpotConfig> = {
	river: spot('As Kh 7d 2c 9h', raise),
	turn: spot('As Kh 7d 2c', raise),
	flop: spot('As Kh 7d', noRaise),
	monotone: spot('Ks 9s 4s', noRaise),
};
