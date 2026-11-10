/**
 * Walking a solved spot on the benchmark page (issue #144): every decision,
 * through the cards dealt, as the page draws it.
 */

import { describe, expect, it } from 'vitest';
import { defineSpot, NodeKind, solve } from '../src/index.ts';
import { nodeView, stepOf } from '../site/lib/explore.ts';

const spot = defineSpot({
	board: 'Ks 9d 4c 2h',
	pot: 10,
	stack: 50,
	oop: 'AA,KQs,98s,76s',
	ip: 'KK,AKo,T9s,QJs',
	betSizes: [[0.5, 1]],
	maxRaises: 2,
});
const solution = solve(spot, { iterations: 30 });

describe('site explore', () => {
	it('shows the first decision with every action and where it leads', () => {
		const root = nodeView(spot, solution, 0, 0);
		expect(root.player).toBe(0);
		expect(root.round).toBe(0);
		expect(root.cards).toBe('Ks 9d 4c 2h');
		expect(root.pot).toBe(10);
		expect(root.actions).toEqual(['check', 'bet 5', 'bet 10']);
		expect(root.frequencies.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
		expect(root.runouts).toEqual([]);
		// Every cell held is a mix that adds up to one; the rest are null.
		const held = root.cells.filter((c) => c !== null);
		expect(held.length).toBe(4);
		for (const mix of held) expect(mix!.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
		// Each action leads to IP's decision on the same street.
		for (const step of root.next) expect(step).toMatchObject({ board: 0, dealt: false });
		expect(nodeView(spot, solution, root.next[1]!.node, 0).player).toBe(1);
	});

	it('follows a line through the river card and switches between rivers', () => {
		const root = nodeView(spot, solution, 0, 0);
		const ip = nodeView(spot, solution, root.next[0]!.node, 0);
		const check = ip.actions.indexOf('check');
		const river = stepOf(spot, ip.node, 0, check)!;
		expect(river.dealt).toBe(true);
		const view = nodeView(spot, solution, river.node, river.board);
		expect(view.round).toBe(1);
		expect(view.player).toBe(0);
		expect(view.cards.split(' ')).toHaveLength(5);
		expect(view.runouts.length).toBe(spot.runouts.counts[1]);
		expect(view.runouts.map((r) => r.board)).toContain(river.board);
		// Another river: the same decision, on its own card.
		const other = view.runouts[view.runouts.length - 1];
		const there = nodeView(spot, solution, river.node, other.board);
		expect(there.cards.endsWith(other.card)).toBe(true);
		expect(there.actions).toEqual(view.actions);
	});

	it('ends the line at a fold, a call on the river and showdown', () => {
		const root = nodeView(spot, solution, 0, 0);
		const facing = nodeView(spot, solution, root.next[1]!.node, 0);
		expect(facing.actions[0]).toBe('fold');
		expect(facing.next[0]).toBeNull();
		// Calling on the turn deals the river; calling on the river ends the hand.
		expect(facing.next[facing.actions.indexOf('call')]!.dealt).toBe(true);
		const river = facing.next[facing.actions.indexOf('call')]!;
		const riverRoot = nodeView(spot, solution, river.node, river.board);
		const riverFacing = nodeView(spot, solution, riverRoot.next[1]!.node, river.board);
		expect(riverFacing.next[riverFacing.actions.indexOf('call')]).toBeNull();
	});

	it('refuses what is not a decision on a stored board', () => {
		const terminal = spot.tree.kind.findIndex((k) => k === NodeKind.TerminalFold);
		expect(() => nodeView(spot, solution, terminal, 0)).toThrow(/not a decision/);
		expect(() => nodeView(spot, solution, 0, 1)).toThrow(/no board/);
	});
});
