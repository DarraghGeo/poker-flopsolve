/**
 * Re-solving a street of a Lite solve on the benchmark page (issue #147).
 *
 * Purpose: Lite keeps the caller's bet sizes, raise sizes and raise count on
 * the first street only. When the walk-through deals a turn or river card,
 * the page solves that subgame again at the caller's own betting, so the
 * street being looked at plays the game the form asked for.
 *
 * A subgame with a street still to come gets Lite's treatment itself: its
 * first street in full, the next simplified, so it fits beside the solve it
 * came from; the river, the last street, is solved in full to an
 * exploitability target.
 */

import { bettingFrom, litePreset, parseCards } from '../../src/index.ts';
import type { Solution, SolveOptions, SpotConfig } from '../../src/index.ts';
import type { SettleOptions } from '../../src/settle.ts';

/** A river re-solve stops at this exploitability, % of its pot. */
export const RIVER_TARGET = 0.5;

/** A re-solve's iteration cap. */
export const RESOLVE_CAP = 2000;

/** A subgame to solve, and how. */
export interface ResolvePlan {
	/** The spot solved: the subgame, at Lite's simplification when a street follows. */
	readonly config: SpotConfig;
	/** The street it opens, 0 at the original spot's first. */
	readonly round: number;
	/** Solve options: Lite's settle stop and sampling, or none on the river. */
	readonly options: SolveOptions;
	/** Lite's stop when a street follows; null on the river, which stops at `target`. */
	readonly settle: SettleOptions | null;
	/** The river's exploitability target, % of the pot; null under `settle`. */
	readonly target: number | null;
}

/**
 * The re-solve of `parent`'s subgame at `node` on `board`, at the betting of
 * `source` (the caller's spot) from the street the node opens; `base` is the
 * street `parent`'s spot began on, 0 for the original. The subgame is
 * refused above `maxBytes` of storage.
 */
export function resolvePlan(source: SpotConfig, parent: Solution, node: number, board: number, base: number, maxBytes: number): ResolvePlan {
	const round = base + parent.spot.tree.round[node];
	const subgame = parent.subgameAt(node, board, { ...bettingFrom(source, round), maxBytes });
	if (parseCards(subgame.board).length < 5) {
		const preset = litePreset(subgame);
		const settle = preset.options.settle;
		return { config: preset.config, round, options: preset.options, settle: settle ?? null, target: null };
	}
	return { config: subgame, round, options: {}, settle: null, target: RIVER_TARGET };
}
