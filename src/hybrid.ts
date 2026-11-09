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

import type { Solution } from './index.ts';
import { defineSpot } from './index.ts';
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
		// Only the first round's decisions lie on the path, so its one board serves.
		const share = matchupMass(solution.reachAt(child, 0, 0), solution.reachAt(child, 0, 1)) / rootMass;
		lines.push({ line: solution.path(child), node: child, share });
	}
	return lines.sort((a, b) => b.share - a.share);
}

/**
 * The most-reached lines (`turnLineReach`) that `ShareHistories.keepLines`
 * can keep with the spot's storage, at 32 bits as `estimate.bytes` counts
 * it, at most `maxBytes`: the longest prefix of the ranking that fits.
 * Keeping a line never shrinks storage, so the prefix is found by bisection.
 * Every line, if all fit; none, if not even the first does.
 */
export function linesWithin(solution: Solution, maxBytes: number): string[] {
	const config = solution.spot.source;
	const asked = config.shareHistories;
	if (!asked) throw new Error('linesWithin picks lines to keep out of shareHistories; this spot shares nothing');
	const share = asked === true ? {} : asked;
	const ranked = turnLineReach(solution).map((l) => l.line);
	const lines = (count: number): string[] => [...new Set([...(share.keepLines ?? []), ...ranked.slice(0, count)])];
	const fits = (count: number): boolean =>
		defineSpot({ ...config, maxBytes: Number.MAX_SAFE_INTEGER, shareHistories: { ...share, keepLines: lines(count) } }).estimate.bytes <= maxBytes;
	let low = 0;
	let high = ranked.length;
	if (!fits(0)) return [];
	// fits(low) holds; find the largest count that fits.
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(mid)) low = mid;
		else high = mid - 1;
	}
	return ranked.slice(0, low);
}
