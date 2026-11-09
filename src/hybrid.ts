/**
 * Hybrid history sharing (issue #101): share later-street storage between
 * histories except along the lines most often played.
 *
 * Purpose: a solve with `shareHistories` keeps its flop play, but the ranges
 * it brings to a turn are trained against river values that several
 * histories share, so a turn re-solved from it starts from distorted ranges.
 * `ShareHistories.keepLines` gives named lines storage of their own, and
 * `turnLineReach` ranks the flop lines by how often they are reached, to
 * pick them.
 */

import type { Solution } from './index.ts';
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
