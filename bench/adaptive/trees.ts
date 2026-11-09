/**
 * Named trees for issue #51: the full T and T₀, and budgeted cuts of T.
 */

import type { SpotConfig } from '../../src/index.ts';
import { T0_BETTING, T_BETTING, THREE } from './spots.ts';

export const TREES: Record<string, Partial<SpotConfig>> = {
	T: T_BETTING,
	T0: T0_BETTING,
	/** One size, 0.75, on every round; T's raises. */
	one: { ...T_BETTING, betSizes: [[0.75]] },
	/** Static rule: three opening sizes on flop and turn, one on the river, a shove as the only raise. */
	staticShove: { betSizes: [[...THREE], [...THREE], [0.75]], raiseSizes: [['allin']], allowAllIn: false, maxRaises: 3 },
};
