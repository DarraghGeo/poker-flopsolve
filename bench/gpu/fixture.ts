/**
 * Data for the GPU river kernels' bench and tests (#39).
 *
 * Purpose: one spot's river lists exactly as a solve lays them out, the
 * counts that say how often a training iteration runs each kernel, and
 * deterministic reach and regrets to feed them. Pure code, so it runs in Node
 * and, bundled, in the browser.
 */

import { COMBOS } from '../../src/cards.ts';
import { buildActiveLists } from '../../src/cfr.ts';
import { defineSpot } from '../../src/index.ts';
import type { SpotConfig } from '../../src/index.ts';
import { buildShowdownTable } from '../../src/showdown.ts';
import { NodeKind } from '../../src/tree.ts';
import { riverLists } from '../../src/gpu/river.ts';
import type { RiverLists } from '../../src/gpu/river.ts';

/** A spot's river, ready for the kernels. */
export interface RiverFixture {
	readonly lists: RiverLists;
	/** Showdown nodes on the river, each run on every river board per traversal. */
	readonly showdownNodes: number;
	/** Showdown scale of the first river showdown: its payoff over the chip scale. */
	readonly scale: number;
	/** River decision nodes: who acts and how many actions. Each is regret-matched on every river board per traversal. */
	readonly decisions: readonly { player: 0 | 1; actions: number }[];
}

/** Build a spot and lay out its river as a solve does. */
export function riverFixture(config: SpotConfig): RiverFixture {
	const spot = defineSpot(config);
	const relevant = new Uint8Array(COMBOS);
	for (const combo of spot.players[0].combos) relevant[combo] = 1;
	for (const combo of spot.players[1].combos) relevant[combo] = 1;
	const showdown = buildShowdownTable(spot.runouts, relevant);
	const active = buildActiveLists(spot.runouts, spot.players, showdown);
	const lists = riverLists(active, spot.runouts);
	const { tree } = spot;
	const last = spot.runouts.rounds - 1;
	let showdownNodes = 0;
	let scale = 0;
	const decisions: { player: 0 | 1; actions: number }[] = [];
	for (let node = 0; node < tree.kind.length; node++) {
		if (tree.round[node] !== last) continue;
		if (tree.kind[node] === NodeKind.TerminalShowdown) {
			if (showdownNodes === 0) scale = tree.payoff[node] / spot.chipScale;
			showdownNodes++;
		} else if (tree.kind[node] === NodeKind.Decision) {
			decisions.push({ player: tree.player[node] as 0 | 1, actions: tree.numEdges[node] });
		}
	}
	return { lists, showdownNodes, scale, decisions };
}

/** A deterministic generator in [0, 1). */
export function generator(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 4294967296;
	};
}

/** Reach by entry: a third of the hands at zero, as late in a solve. */
export function makeReach(lists: RiverLists, seed: number): Float32Array {
	const random = generator(seed);
	const reach = new Float32Array(lists.entries);
	for (let e = 0; e < lists.entries; e++) reach[e] = random() < 0.33 ? 0 : random();
	return reach;
}

/**
 * One river decision node's blocks on every river board: three i32 per
 * block (offset in floats, actions, hands), packed one after another, and
 * regrets for them — a quarter negative, a few hands with none positive, so
 * the uniform fallback is exercised.
 */
export function makeBlocks(lists: RiverLists, player: 0 | 1, actions: number, seed: number): { blocks: Int32Array; regret: Float32Array } {
	const blocks = new Int32Array(lists.boards * 3);
	let offset = 0;
	for (let board = 0; board < lists.boards; board++) {
		const hands = lists.count[board * 2 + player];
		blocks.set([offset, actions, hands], board * 3);
		offset += actions * hands;
	}
	const random = generator(seed);
	const regret = new Float32Array(offset);
	for (let i = 0; i < offset; i++) {
		const roll = random();
		regret[i] = roll < 0.25 ? -random() * 10 : roll < 0.3 ? 0 : random() * 10;
	}
	return { blocks, regret };
}
