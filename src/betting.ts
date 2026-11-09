/**
 * The betting tree from a spot's settings (issue #115).
 *
 * Purpose: one place that turns `SpotConfig`'s betting into the tree
 * builder's settings, for `defineSpot` and for the presets, which compare the
 * caller's tree with their own to report the sizes they cut.
 */

import { parseCards } from './cards.ts';
import type { SpotConfig } from './index.ts';
import type { BetSize, PerPlayer, Tree } from './tree.ts';
import { buildTree, isPerPlayer } from './tree.ts';

/** Sub-chip resolution, so pot-fraction sizing is exact: units per chip unless `SpotConfig.chipScale` says otherwise. */
export const DEFAULT_CHIP_SCALE = 100;

/** `config.betSizes` as one row per round for each player, checked against the board's rounds. */
export function betRows(config: SpotConfig, rounds: number): PerPlayer<readonly (readonly BetSize[])[]> {
	const rowsFor = (sizes: readonly (readonly BetSize[])[], who: string): readonly (readonly BetSize[])[] => {
		const expanded = sizes.length === 1 ? Array.from({ length: rounds }, () => sizes[0]) : sizes;
		if (expanded.length !== rounds) {
			throw new Error(
				`${who}betSizes has ${sizes.length} rows but this board has ${rounds} ` +
					'betting rounds; give one row per round, or a single row for all of them',
			);
		}
		return expanded;
	};
	return isPerPlayer(config.betSizes)
		? { oop: rowsFor(config.betSizes.oop, 'oop '), ip: rowsFor(config.betSizes.ip, 'ip ') }
		: rowsFor(config.betSizes, '');
}

/** The tree builder's settings for `config`, sizes given as `betRows` gives them. */
export function treeConfig(config: SpotConfig, rows: PerPlayer<readonly (readonly BetSize[])[]>): Parameters<typeof buildTree>[0] {
	const chipScale = config.chipScale ?? DEFAULT_CHIP_SCALE;
	return {
		potUnits: Math.round(config.pot * chipScale),
		stackUnits: Math.round(config.stack * chipScale),
		betSizes: rows,
		raiseSizes: config.raiseSizes,
		maxRaises: config.maxRaises ?? 1,
		allowAllIn: config.allowAllIn ?? false,
		allInThreshold: config.allInThreshold,
		noDonk: config.noDonk,
		mergeSizes: config.mergeSizes,
		removeActions: config.removeActions,
		thinSizes: config.thinSizes,
		chipScale,
		minRaiseUnits: chipScale,
	};
}

/**
 * The betting tree `defineSpot(config)` would build, alone: no ranges,
 * runouts or storage, so it is cheap for any tree, and `maxBytes` is not
 * checked.
 */
export function bettingTree(config: SpotConfig): Tree {
	const rounds = 6 - parseCards(config.board).length;
	if (rounds < 1 || rounds > 3) throw new Error(`A postflop board has 3, 4 or 5 cards; got ${config.board}`);
	return buildTree(treeConfig(config, betRows(config, rounds)), { rounds });
}
