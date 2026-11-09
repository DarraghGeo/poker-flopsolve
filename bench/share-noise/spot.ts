/** #103's small turn spot, where issue #105 was found. */
import type { SpotConfig } from '../../src/index.ts';

export const TURN_SPOT: SpotConfig = {
	board: 'Ah Kd Qc 8s', pot: 60, stack: 90,
	oop: 'AA,KK,55,44,AKs,KQs', ip: 'QQ,JJ,33,22,AQs,QJs',
	betSizes: [[0.5, 1], [0.5, 1]], raiseSizes: [1], maxRaises: 2,
	shareHistories: true,
};
