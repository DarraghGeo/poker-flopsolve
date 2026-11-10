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

describe('site explore on a flop', () => {
	const flop = defineSpot({ board: 'Ks 9d 4c', pot: 10, stack: 50, oop: 'AA,KQs,98s', ip: 'KK,AKo,T9s', betSizes: [[0.5]], maxRaises: 2 });
	const flopSolution = solve(flop, { iterations: 5 });

	it('names bets by what goes in on this street', () => {
		const root = nodeView(flop, flopSolution, 0, 0);
		expect(root.actions).toEqual(['check', 'bet 5']);
		const facing = nodeView(flop, flopSolution, root.next[1]!.node, 0);
		// A raise to 15 on the flop: 15 in this street.
		expect(facing.actions).toEqual(['fold', 'call', 'raise 15']);
		const turn = facing.next[1]!;
		expect(turn).toMatchObject({ dealt: true, round: 1 });
		const view = nodeView(flop, flopSolution, turn.node, turn.board);
		expect(view.pot).toBe(20);
		// Half the 20 pot, not 15 counting the flop's 5.
		expect(view.actions).toEqual(['check', 'bet 10']);
		const facingTurn = nodeView(flop, flopSolution, view.next[1]!.node, turn.board);
		expect(facingTurn.actions).toEqual(['fold', 'call', 'raise 30']);
		expect(facingTurn.next[0]).toBeNull();
	});

	it('lists the cards each stored runout stands for', () => {
		const mono = defineSpot({ board: 'Ks 9s 4s', pot: 10, stack: 20, oop: 'AA', ip: 'QQ', betSizes: [[1]] });
		const monoSolution = solve(mono, { iterations: 2 });
		const turn = stepOf(mono, 0, 0, 0)!; // OOP checks
		const river = stepOf(mono, turn.node, 0, 0)!; // IP checks: the turn comes
		const view = nodeView(mono, monoSolution, river.node, river.board);
		const dealt = view.runouts.flatMap((r) => [r.card, ...r.also]);
		// Every turn card that can come is offered, once.
		expect(new Set(dealt).size).toBe(dealt.length);
		expect(dealt.length).toBe(49);
		const twos = view.runouts.find((r) => r.card.startsWith('2') && !r.card.endsWith('s'))!;
		expect(twos.also.length).toBe(2);
	});
});
