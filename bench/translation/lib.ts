/** Helpers shared by the action-translation experiment (issue #54). */
import { COMBO_CARDS } from '../../src/cards.ts';
import { orbitLeader, type PlayerIndex } from '../../src/cfr.ts';
import type { Runouts } from '../../src/runouts.ts';

/** Live hand rows per (round, player), summed over stored boards. */
export function liveRows(runouts: Runouts, players: readonly [PlayerIndex, PlayerIndex]): Float64Array {
	const totals = new Float64Array(runouts.rounds * 2);
	const onBoard = new Uint8Array(52);
	for (let round = 0; round < runouts.rounds; round++) {
		const width = runouts.width[round];
		const cards = runouts.cards[round];
		for (let board = 0; board < runouts.counts[round]; board++) {
			onBoard.fill(0);
			for (let i = 0; i < width; i++) onBoard[cards[board * width + i]] = 1;
			for (let player = 0; player < 2; player++) {
				const index = players[player];
				for (let i = 0; i < index.count; i++) {
					const combo = index.combos[i];
					if (onBoard[COMBO_CARDS[combo * 2]] || onBoard[COMBO_CARDS[combo * 2 + 1]]) continue;
					if (!orbitLeader(runouts, round, board, combo)) continue;
					totals[round * 2 + player]++;
				}
			}
		}
	}
	return totals;
}
