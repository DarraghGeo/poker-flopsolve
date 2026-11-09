/**
 * napkinpoker's 70 full-hand reference solves (issue #87): the imported
 * fixtures load, describe the very game this solver builds from their configs,
 * and agree with those configs.
 */

import { describe, expect, it } from 'vitest';
import { COMBO_CARDS, COMBOS, parseCards } from '../src/cards.ts';
import { defineSpot } from '../src/index.ts';
import { parseRange } from '../src/range.ts';
import { matchLabel, napkinNodes, napkinSpots, nodeAt, weightsOf } from '../bench/reference/napkinpoker.ts';

const texture = (board: string): string => {
	const cards = board.match(/../g)!;
	const suits = new Set(cards.map((c) => c[1])).size;
	const paired = new Set(cards.map((c) => c[0])).size < 3;
	return (suits === 1 ? 'monotone' : suits === 2 ? 'two-tone' : 'rainbow') + (paired ? ' paired' : '');
};

describe('napkinpoker reference solves', () => {
	const spots = napkinSpots();
	const built = new Map(spots.map((s) => [s.id, defineSpot({ ...s.config, maxBytes: 1e13 })]));

	it('holds 70 spots across every flop texture, with their stored nodes', () => {
		expect(spots).toHaveLength(70);
		const textures: Record<string, number> = {};
		for (const s of spots) {
			const kind = texture(s.config.board.replace(/ /g, ''));
			textures[kind] = (textures[kind] ?? 0) + 1;
		}
		expect(textures).toEqual({ 'two-tone': 31, rainbow: 23, 'rainbow paired': 7, 'two-tone paired': 6, monotone: 3 });
		expect(napkinNodes('flop')).toHaveLength(439);
		expect(napkinNodes('turn')).toHaveLength(838);
		for (const node of [...napkinNodes('flop'), ...napkinNodes('turn')]) expect(built.has(node.spot)).toBe(true);
	});

	it('every stored node is a node of the tree built from its config, action for action', () => {
		for (const node of [...napkinNodes('flop'), ...napkinNodes('turn')]) {
			const match = nodeAt(built.get(node.spot)!, node.path);
			expect(match.actor, node.id).toBe(node.actor);
			expect(match.labels.length, `${node.id} ${node.path.join(',')}`).toBe(node.actions.length);
			for (const label of node.actions) expect(matchLabel(match.labels, label), `${node.id} ${label}`).toBeGreaterThanOrEqual(0);
		}
	});

	it("the actor's reach at its first decision is exactly its configured range", () => {
		let checked = 0;
		for (const node of napkinNodes('flop')) {
			// OOP at the root, and IP after a check: neither has acted, so reach is the range.
			const first = node.path.length === 0 || (node.path.length === 1 && node.path[0] === 'X');
			if (!first || node.actor !== node.path.length) continue;
			const spot = spots.find((s) => s.id === node.spot)!;
			const range = parseRange((node.actor === 0 ? spot.config.oop : spot.config.ip) as string);
			const board = new Set(parseCards(spot.config.board));
			const reach = weightsOf(node);
			for (let c = 0; c < COMBOS; c++) {
				if (board.has(COMBO_CARDS[c * 2]) || board.has(COMBO_CARDS[c * 2 + 1])) continue;
				expect(reach[c] / 10000).toBeCloseTo(range[c], 4);
			}
			checked++;
		}
		expect(checked).toBe(139);
	});

	it('stores a strategy summing to one and an EV for every action and combination', () => {
		for (const node of [...napkinNodes('flop'), ...napkinNodes('turn')]) {
			expect(node.strategy).toHaveLength(node.actions.length);
			expect(node.ev).toHaveLength(node.actions.length);
			for (let i = 0; i < node.combos.length; i++) {
				let sum = 0;
				for (const row of node.strategy) sum += row[i];
				expect(Math.abs(sum - 1), node.id).toBeLessThanOrEqual(0.005);
			}
		}
	});
});
