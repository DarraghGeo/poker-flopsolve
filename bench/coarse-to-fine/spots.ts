/**
 * The spots issue #24 measures: `flop` and `monotone` from
 * `bench/compare/spots.ts`, and the wide flop of `bin/bench.ts` (198 vs 165
 * combinations; the README's "211 vs 203" row predates the current ranges).
 */

import type { SpotConfig } from '../../src/index.ts';
import { SPOTS as COMPARE } from '../compare/spots.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';

export const SPOTS: Record<string, SpotConfig> = {
	flop: COMPARE.flop,
	monotone: COMPARE.monotone,
	wide: { board: 'AsKh7d', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.66]], maxRaises: 1 },
};
