/**
 * The spots the turn-leaf experiment measures (issue #22): `flop` and
 * `monotone` from the compare bench, a wide flop near the README's 211 vs
 * 203 combos (213 vs 208 here), and the flop with pairs-and-broadway ranges.
 */
import type { SpotConfig } from '../../src/index.ts';
import { SPOTS } from '../compare/spots.ts';

const WIDE_OOP = '22+,A2s+,K8s+,Q9s+,J9s+,T9s,98s,87s,ATo+,KJo+,QJo';
const WIDE_IP = '22+,A2s+,K9s+,Q9s+,J9s+,T8s+,98s,87s,76s,ATo+,KQo,QJo';
const PAIRS_BROADWAY = '22+,ATs+,KTs+,QTs+,JTs,ATo+,KTo+,QTo+,JTo';
export const MEASURE: Record<string, SpotConfig> = {
	flop: SPOTS.flop,
	monotone: SPOTS.monotone,
	wide: { ...SPOTS.flop, oop: WIDE_OOP, ip: WIDE_IP },
	flopPB: { ...SPOTS.flop, oop: PAIRS_BROADWAY, ip: PAIRS_BROADWAY },
};
