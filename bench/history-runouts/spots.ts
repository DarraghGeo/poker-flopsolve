/**
 * The spots of the tree-size round (#20): T, T0 and their monotone twins.
 * Ranges are the bench ranges of `bench/compare/spots.ts`.
 */

import type { SpotConfig } from '../../src/index.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';

const base = { pot: 55, stack: 975, oop: OOP, ip: IP, betSizes: [[0.33, 0.75, 1.5]], allowAllIn: true };
const target = { ...base, raiseSizes: [[0.75]], maxRaises: 3 };
const reference = { ...base, raiseSizes: [['allin']], maxRaises: 2 };

export const SPOTS: Record<string, SpotConfig> = {
	T: { board: 'As Kh 7d', ...target } as SpotConfig,
	T0: { board: 'As Kh 7d', ...reference } as SpotConfig,
	M: { board: 'Ks 9s 4s', ...target } as SpotConfig,
	M0: { board: 'Ks 9s 4s', ...reference } as SpotConfig,
};

/** A small flop of the same shape, for trying the scripts out. */
SPOTS.S = { board: 'As Kh 7d', pot: 55, stack: 300, oop: 'AA-QQ,AKs,KQs,AKo,76s', ip: 'JJ-99,AQs,QJs,JTs,AQo', betSizes: [[0.33, 0.75]], raiseSizes: [[0.75]], allowAllIn: true, maxRaises: 3 } as SpotConfig;
