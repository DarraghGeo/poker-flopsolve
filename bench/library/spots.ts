/**
 * The spots the flop-library experiment (#30) measures, each with the nearby
 * flops a library might hold for it.
 *
 * `flop` and `monotone` are those of `bench/compare/spots.ts`; `wide` is the
 * same flop with ranges widened to about the README's 211 vs 203 combos
 * (213 vs 205 here). A neighbour is another flop and the rank swap carrying
 * it onto the target, so every hand keeps its role: 66 on AsKh6d is 77 on
 * AsKh7d.
 */

import { SPOTS as COMPARE } from '../compare/spots.ts';
import type { SpotConfig } from '../../src/index.ts';

export interface Neighbour {
	readonly board: string;
	/** The two ranks swapped, as rank characters. */
	readonly swap: readonly [string, string];
}

export interface LibrarySpot {
	readonly config: SpotConfig;
	readonly neighbours: readonly Neighbour[];
}

const OOP_WIDE = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AKo-ATo,KQo-KJo,QJo';
const IP_WIDE = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,65s,JJ,AQo-ATo,KQo-KTo,QJo';

export const SPOTS: Record<string, LibrarySpot> = {
	flop: {
		config: COMPARE.flop,
		neighbours: [
			{ board: 'As Kh 6d', swap: ['6', '7'] },
			{ board: 'As Qh 7d', swap: ['Q', 'K'] },
		],
	},
	monotone: {
		config: COMPARE.monotone,
		neighbours: [
			{ board: 'Ks 9s 5s', swap: ['5', '4'] },
			{ board: 'Ks 8s 4s', swap: ['8', '9'] },
		],
	},
	wide: {
		config: { ...COMPARE.flop, oop: OOP_WIDE, ip: IP_WIDE },
		neighbours: [
			{ board: 'As Kh 6d', swap: ['6', '7'] },
			{ board: 'As Qh 7d', swap: ['Q', 'K'] },
		],
	},
};
