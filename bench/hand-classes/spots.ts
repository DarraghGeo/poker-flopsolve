/**
 * The spots issue #40 measures: `flop` (As Kh 7d) and `monotone` (Ks 9s 4s)
 * from `bench/compare/spots.ts`, and the monotone flop with pairs-and-broadway
 * ranges, the three #28 and #31 counted.
 */

import type { SpotConfig } from '../../src/index.ts';
import { SPOTS as COMPARE } from '../compare/spots.ts';

const PAIRS_BROADWAY = '22+,ATs+,KTs+,QTs+,JTs,ATo+,KTo+,QTo+,JTo';

export const SPOTS: Record<string, SpotConfig> = {
	flop: COMPARE.flop,
	monotone: COMPARE.monotone,
	monotonePB: { ...COMPARE.monotone, oop: PAIRS_BROADWAY, ip: PAIRS_BROADWAY },
};
