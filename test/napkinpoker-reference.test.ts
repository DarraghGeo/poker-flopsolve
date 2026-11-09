/**
 * napkinpoker's 70 full-hand reference solves (issue #87): the imported
 * fixtures load, describe the very game this solver builds from their configs,
 * and agree with those configs.
 */

import { describe, expect, it } from 'vitest';
import { COMBO_CARDS, COMBOS, parseCards } from '../src/cards.ts';
import { defineSpot } from '../src/index.ts';
import type { Spot } from '../src/index.ts';
import { parseRange } from '../src/range.ts';
import { napkinNodes, napkinSpots, nodeAt, pairActions, weightsOf } from '../bench/reference/napkinpoker.ts';

const texture = (board: string): string => {
	const cards = board.match(/../g)!;
	const suits = new Set(cards.map((c) => c[1])).size;
	const paired = new Set(cards.map((c) => c[0])).size < 3;
	return (suits === 1 ? 'monotone' : suits === 2 ? 'two-tone' : 'rainbow') + (paired ? ' paired' : '');
};

describe('napkinpoker reference solves', () => {
	const spots = new Map(napkinSpots().map((s) => [s.id, s]));
	const allNodes = [...napkinNodes('flop'), ...napkinNodes('turn')];

	/** Spots are built on first use, and a config that fails names its spot. */
	const built = new Map<string, Spot>();
	const spotOf = (id: string): Spot => {
		let spot = built.get(id);
		if (!spot) {
			try {
				spot = defineSpot({ ...spots.get(id)!.config, maxBytes: 1e13 });
			} catch (error) {
				throw new Error(`spot ${id}: ${(error as Error).message}`);
			}
			built.set(id, spot);
		}
		return spot;
	};

	it('holds 70 spots across every flop texture, with their stored nodes', () => {
		expect(spots.size).toBe(70);
		const textures: Record<string, number> = {};
		for (const s of spots.values()) {
			const kind = texture(s.config.board.replace(/ /g, ''));
			textures[kind] = (textures[kind] ?? 0) + 1;
		}
		expect(textures).toEqual({ 'two-tone': 31, rainbow: 23, 'rainbow paired': 7, 'two-tone paired': 6, monotone: 3 });
		expect(napkinNodes('flop')).toHaveLength(439);
		expect(napkinNodes('turn')).toHaveLength(838);
		for (const node of allNodes) expect(spots.has(node.spot), node.id).toBe(true);
	});

	it('every stored node is a node of the tree built from its config, action for action', () => {
		for (const node of allNodes) {
			const where = `${node.id} ${node.path.join(',')}`;
			const match = nodeAt(spotOf(node.spot), node.path);
			expect(match.actor, where).toBe(node.actor);
			// One to one: every stored action pairs with a distinct action of ours.
			expect(pairActions(match.labels, node.actions), `${where}: ours ${match.labels}, stored ${node.actions}`).not.toBeNull();
		}
	});

	it('every stored turn node sits on its spot board plus a stored turn card', () => {
		for (const node of napkinNodes('turn')) {
			const spot = spots.get(node.spot)!;
			const match = nodeAt(spotOf(node.spot), node.path);
			expect(match.dealt, node.id).toHaveLength(1);
			const [card] = match.dealt;
			expect(spot.turns, node.id).toContain(card);
			expect(node.id, node.id).toBe(`${node.spot}-${card}`);
			expect(node.board, node.id).toBe(spot.config.board.replace(/ /g, '') + card);
			expect(parseCards(spot.config.board), node.id).not.toContain(parseCards(card)[0]);
		}
		for (const node of napkinNodes('flop')) expect(node.board, node.id).toBe(spots.get(node.spot)!.config.board.replace(/ /g, ''));
	});

	it("the actor's reach at its first decision is exactly its configured range", () => {
		let checked = 0;
		for (const node of napkinNodes('flop')) {
			// OOP at the root, and IP after a check: neither has acted, so reach is the range.
			const first = node.path.length === 0 || (node.path.length === 1 && node.path[0] === 'X');
			if (!first || node.actor !== node.path.length) continue;
			const spot = spots.get(node.spot)!;
			const range = parseRange((node.actor === 0 ? spot.config.oop : spot.config.ip) as string);
			const board = new Set(parseCards(spot.config.board));
			const reach = weightsOf(node);
			for (let c = 0; c < COMBOS; c++) {
				if (board.has(COMBO_CARDS[c * 2]) || board.has(COMBO_CARDS[c * 2 + 1])) continue;
				expect(reach[c], node.id).toBeCloseTo(range[c], 4);
			}
			checked++;
		}
		expect(checked).toBe(139);
	});

	it('stores, for every action and combination, a probability summing to one and an EV', () => {
		for (const node of allNodes) {
			const n = node.combos.length;
			expect(node.weight, node.id).toHaveLength(n);
			expect(node.strategy, node.id).toHaveLength(node.actions.length);
			expect(node.ev, node.id).toHaveLength(node.actions.length);
			const rows = [...node.strategy, ...node.ev];
			expect(rows.every((row) => row.length === n), node.id).toBe(true);
			expect(rows.every((row) => row.every(Number.isFinite)), node.id).toBe(true);
			let worst = 0;
			for (let i = 0; i < n; i++) {
				let sum = 0;
				for (const row of node.strategy) sum += row[i];
				worst = Math.max(worst, Math.abs(sum - 1));
			}
			expect(worst, node.id).toBeLessThanOrEqual(0.005);
		}
	});
});
