/**
 * Spots for the EV-convergence experiment of issue #27: `flop` and `monotone`
 * from bench/compare, and a wide flop near the README's 211 vs 203 (whose
 * ranges the README does not give): Qs Jh 2c, 230 vs 195 combos, 33M slots.
 */

import type { SpotConfig } from '../../src/index.ts';
import { SPOTS as COMPARE } from '../compare/spots.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo,QJo,JTo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo,65s,KJo,QJo';

export const EV_SPOTS: Record<string, SpotConfig> = {
	flop: COMPARE.flop,
	monotone: COMPARE.monotone,
	wide: { board: 'Qs Jh 2c', pot: 100, stack: 200, oop: OOP, ip: IP, betSizes: [[0.5]], maxRaises: 1 },
};
