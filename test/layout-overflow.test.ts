/**
 * Trees with more than 2^31 storage slots: the round's target spot T.
 *
 * T has 2,301,154,284 slots, so 32-bit offsets wrap for its later nodes.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { defineSpot } from '../src/index.ts';
import type { Spot, SpotConfig } from '../src/index.ts';
import { blockBase, buildLayout } from '../src/cfr.ts';
import type { Layout } from '../src/cfr.ts';
import { createEngine, engineAvailable } from '../src/engine.ts';
import type { EngineInput } from '../src/engine.ts';
import { SPOTS } from '../bench/compare/spots.ts';

const T: SpotConfig = {
	...SPOTS.flop,
	pot: 55, stack: 975,
	betSizes: [[0.33, 0.75, 1.5]], raiseSizes: [[0.75]], allowAllIn: true, maxRaises: 3,
	// Only the tree and layout are built here, never the storage.
	maxBytes: 2 ** 40,
};

describe('layouts past 2^31 slots', () => {
	let spot: Spot;
	let layout: Layout;
	beforeAll(() => {
		spot = defineSpot(T);
		layout = buildLayout(spot.tree, spot.runouts, spot.players, 2);
	});

	it('gives every node of T a non-negative offset inside storage', () => {
		expect(layout.totalSlots).toBe(2_301_154_284);
		const { tree } = spot;
		const nodes = tree.decisionNodes;
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			const start = layout.offset[node];
			const end = i + 1 < nodes.length ? layout.offset[nodes[i + 1]] : layout.totalSlots;
			expect(start).toBeGreaterThanOrEqual(0);
			expect(end).toBeGreaterThanOrEqual(start);
			// Every board's block lies within the node's storage.
			const boards = spot.runouts.counts[tree.round[node]];
			expect(blockBase(layout, tree, node, 0)).toBe(start);
			expect(blockBase(layout, tree, node, boards - 1)).toBeLessThanOrEqual(end);
		}
		expect(layout.offset[nodes[nodes.length - 1]]).toBeGreaterThan(2 ** 31);
	});

	it('keeps 32-bit offsets for a tree that fits them', () => {
		const small = defineSpot(SPOTS.turn);
		expect(buildLayout(small.tree, small.runouts, small.players, 4).offset).toBeInstanceOf(Int32Array);
	});

	it.runIf(engineAvailable())('leaves a layout too large for 32-bit memory to JavaScript', () => {
		// Refused before anything else in the input is read.
		const input = { tree: spot.tree, runouts: spot.runouts, players: spot.players, layout } as unknown as EngineInput;
		expect(createEngine(input)).toBeNull();
	});
});
