/**
 * Spots pinned by `regression.test.ts`.
 *
 * Small enough to solve in a few seconds, and between them they cover every
 * kind of round (river only, a turn deal, a flop deal), both update paths
 * (float and 16-bit), and a two-tone flop, where suit symmetry exists to be
 * exploited.
 */

import type { Precision, SolveOptions, SpotConfig } from '../src/index.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const NARROW_OOP = 'AA,KK,QQ,AKs,AQs,KQs,76s,65s';
const NARROW_IP = 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s';

const river: SpotConfig = { board: 'AsKh7d2c9h', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.33, 0.75]], maxRaises: 2, allowAllIn: true };
const turn: SpotConfig = { board: 'AsKh7d2c', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.33, 0.75]], maxRaises: 2 };
const flop: SpotConfig = { board: 'AsKh7d', pot: 60, stack: 100, oop: NARROW_OOP, ip: NARROW_IP, betSizes: [[0.66]], maxRaises: 1 };
// Isomorphism off: this pins the full enumeration, which folding mirrored
// runouts reorders additions in.
const twotone: SpotConfig = { board: 'Ts9s4h', pot: 60, stack: 100, oop: NARROW_OOP, ip: NARROW_IP, betSizes: [[0.66]], maxRaises: 1, isomorphism: false };

export const SPOTS: Record<string, { config: SpotConfig; iterations: number; precision: Precision; options?: SolveOptions }> = {
	'river f64': { config: river, iterations: 200, precision: 'f64' },
	'river i16': { config: river, iterations: 200, precision: 'i16' },
	'turn f64': { config: turn, iterations: 40, precision: 'f64' },
	'turn i16': { config: turn, iterations: 40, precision: 'i16' },
	'flop f64': { config: flop, iterations: 30, precision: 'f64' },
	'flop i16': { config: flop, iterations: 30, precision: 'i16' },
	'two-tone flop f64': { config: twotone, iterations: 30, precision: 'f64' },
};
