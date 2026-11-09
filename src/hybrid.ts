/**
 * Hybrid history sharing (issue #101): share later-street storage between
 * histories except along the lines most often played.
 *
 * Purpose: a solve with `shareHistories` keeps its flop play, but the ranges
 * it brings to a turn are trained against river values that several
 * histories share, so a turn re-solved from it starts from distorted ranges.
 * `ShareHistories.keepLines` gives named lines storage of their own, and
 * `turnLineReach` ranks the flop lines by how often they are reached, and
 * `linesWithin` picks the most-reached ones a storage budget allows.
 */

import type { Precision, Solution, SpotConfig } from './index.ts';
import { defineSpot, storageCost } from './index.ts';
import { matchupMass } from './cfr.ts';
import { NodeKind } from './tree.ts';

/** A flop line opening the turn, and its share of the root's hand pairs. */
export interface LineReach {
	/** The turn's first decision, as `Solution.path` names it, e.g. `"check check /"`. */
	readonly line: string;
	/** The turn's first decision node. */
	readonly node: number;
	/** Weighted hand pairs reaching the turn by this line over those at the root, 0 to 1. */
	readonly share: number;
}

/**
 * Every line from the spot's first round into the next, most reached first.
 * Reach comes from the average strategy, so take it from a solve that has
 * run a while; the order settles long before the strategy does.
 */
export function turnLineReach(solution: Solution): LineReach[] {
	const { tree, players } = solution.spot;
	if (solution.spot.runouts.rounds < 2) return [];
	const rootMass = matchupMass(players[0].weights, players[1].weights);
	const lines: LineReach[] = [];
	for (let node = 0; node < tree.nodeCount; node++) {
		if (tree.kind[node] !== NodeKind.Chance || tree.round[node] !== 0) continue;
		const child = tree.edgeChild[tree.firstEdge[node]];
		if (tree.kind[child] !== NodeKind.Decision) continue;
		// Only the first round's decisions lie on the path, so any board serves.
		const share = matchupMass(solution.reachAt(child, 0, 0), solution.reachAt(child, 0, 1)) / rootMass;
		lines.push({ line: solution.path(child), node: child, share });
	}
	return lines.sort((a, b) => b.share - a.share);
}

/**
 * The most-reached lines of `solution` (`turnLineReach`) that
 * `ShareHistories.keepLines` can keep in `options.config` with its storage
 * at `options.precision` (compact storage included) at most `maxBytes`: the
 * longest prefix of the ranking that fits, with any lines the config already
 * keeps. Throws if the spot is over budget keeping only those. Keeping a line never shrinks storage, so the
 * prefix is found by bisection.
 *
 * The spot the lines are for, `options.config`, defaults to the one
 * `solution` solved. The ranking can come from a cheaper spot with the same first
 * round: the reach of a flop line is the flop play alone, so a solve with
 * the river checked down ranks the lines much as the real one does, in a
 * fraction of its memory (see `ShareHistories.keepLines`).
 */
export function linesWithin(solution: Solution, maxBytes: number, options: LinesWithinOptions = {}): string[] {
	const config = options.config ?? solution.spot.source;
	const precision = options.precision ?? 'f32';
	const asked = config.shareHistories;
	if (!asked) throw new Error('linesWithin picks lines to keep out of shareHistories; this spot shares nothing');
	const share = asked === true ? {} : asked;
	const ranked = turnLineReach(solution).map((l) => l.line);
	const lines = (count: number): string[] => [...new Set([...(share.keepLines ?? []), ...ranked.slice(0, count)])];
	const bytes = (count: number): number =>
		storageCost(defineSpot({ ...config, maxBytes: Number.MAX_SAFE_INTEGER, shareHistories: { ...share, keepLines: lines(count) } }), precision);
	const least = bytes(0);
	if (least > maxBytes) {
		throw new Error(`linesWithin: the spot needs ${least} bytes keeping no more lines, over the budget of ${maxBytes}`);
	}
	// bytes(low) fits; find the largest count that does.
	let low = 0;
	let high = ranked.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (bytes(mid) <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return lines(low);
}

/** Settings for {@link linesWithin}. */
export interface LinesWithinOptions {
	/** The spot the lines are kept in; unset, the one the ranking solution solved. */
	readonly config?: SpotConfig;
	/** The precision the spot will be solved at, which the budget is for; default 'f32'. */
	readonly precision?: Precision;
}
