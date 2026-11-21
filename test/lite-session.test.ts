/**
 * `openLite`: a Lite blueprint kept live, whose ranges change in place.
 */

import { describe, expect, it } from 'vitest';
import { NodeKind, openLite, parseRange, solveLite } from '../src/index.ts';
import type { Solution, SpotConfig } from '../src/index.ts';

const small: SpotConfig = {
	board: 'Ts 9h 4d 2c', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.33, 0.66], [0.5, 1]],
	maxRaises: 2,
};
const WIDE = `${small.oop as string},JJ,AJs,87s`;
const ONE = { workers: 1, settle: { every: 10 } } as const;

/** Each hand's root action mix, by combination, for hands with weight. */
function rootMix(solution: Solution): Map<number, number[]> {
	const view = solution.strategyAt(0, 0);
	const actions = view.actions.length;
	const weights = solution.spot.players[view.player].weights;
	const mix = new Map<number, number[]>();
	view.combos.forEach((combo, i) => {
		if (weights[combo] > 0) mix.set(combo, Array.from(view.probs.subarray(i * actions, (i + 1) * actions)));
	});
	return mix;
}

/** Mean total variation between two root plays over the hands both hold. */
function apart(a: Solution, b: Solution): number {
	const [ma, mb] = [rootMix(a), rootMix(b)];
	expect([...ma.keys()]).toEqual([...mb.keys()]);
	let sum = 0;
	for (const [combo, probs] of ma) sum += probs.reduce((tv, p, k) => tv + Math.abs(p - mb.get(combo)![k]), 0) / 2;
	return sum / ma.size;
}

describe('openLite', () => {
	it('opens on what solveLite solves', () => {
		const session = openLite(small, ONE);
		// Closed, it reads its storage as solveLite's solution does, off the engine.
		session.close();
		const lite = solveLite(small, ONE);
		expect(session.current.solution.stoppedAt).toBe('settled');
		expect(session.iterations).toBe(lite.solution.iterations);
		expect(Object.is(session.current.solution.ev(0), lite.solution.ev(0))).toBe(true);
		expect(session.current.blueprint).toEqual(lite.blueprint);
		expect(session.current.source).toBe(small);
	});

	it('settles a changed range again, sooner than a new solve and on its play', () => {
		const session = openLite({ ...small, oopReserve: WIDE }, { ...ONE, sampling: false });
		let [warmTotal, coldTotal] = [0, 0];
		try {
			for (const range of [WIDE, `${WIDE},QQ:0.5`, 'AA,KK,AKs,AQs,76s', small.oop as string]) {
				const before = session.iterations;
				const warm = session.setRange(0, range);
				const cold = solveLite({ ...small, oopReserve: WIDE, oop: range }, { ...ONE, sampling: false });
				expect(warm).toBe(session.current);
				expect(warm.solution.stoppedAt).toBe('settled');
				warmTotal += session.iterations - before;
				coldTotal += cold.solution.iterations;
				expect(warm.solution.iterations).toBe(session.iterations);
				expect(apart(warm.solution, cold.solution)).toBeLessThan(0.3);
				// The same game settled twice: its value agrees, and the session,
				// which has more iterations behind it, is no more exploitable.
				expect(Math.abs(warm.solution.ev(0) - cold.solution.ev(0))).toBeLessThan(0.5);
				expect(warm.solution.exploitabilityPercent()).toBeLessThan(cold.solution.exploitabilityPercent() * 1.1);
				expect(Array.from(warm.solution.spot.players[0].weights)).toEqual(Array.from(parseRange(range)));
				expect(warm.source.oop).toBe(range);
			}
			expect(warmTotal).toBeLessThan(coldTotal);
		} finally {
			session.close();
		}
	});

	it('changes either range, sampled, with buckets and shared histories on', () => {
		const flop: SpotConfig = { ...small, board: 'Ts 9h 4d', betSizes: [[0.66], [0.5, 1], [0.5, 1]], maxRaises: 1 };
		const session = openLite(flop, { workers: 2, settle: false, iterations: 30 });
		try {
			expect(session.current.blueprint.runoutBuckets).toBe(3);
			const next = session.setRange(1, 'JJ,TT,AJs,KJs,JTs');
			expect(next.solution.iterations).toBe(60);
			expect(session.iterations).toBe(60);
			expect(Number.isFinite(next.solution.ev(0))).toBe(true);
			expect(next.source.ip).toBe('JJ,TT,AJs,KJs,JTs');
		} finally {
			session.close();
		}
	});

	it('re-solves a later street from the changed range, and stays readable once closed', () => {
		const session = openLite({ ...small, oopReserve: WIDE }, ONE);
		const lite = session.setRange(0, WIDE);
		session.close();
		const { tree } = lite.solution.spot;
		const chance = tree.edgeChild[tree.firstEdge[tree.edgeChild[tree.firstEdge[0]]]];
		expect(tree.kind[chance]).toBe(NodeKind.Chance);
		const resolved = lite.resolve(tree.edgeChild[tree.firstEdge[chance]], 0, { player: 0, iterations: 50 });
		expect(resolved.solution.spot.tree.numEdges[0]).toBe(3);
		expect(resolved.solution.exploitabilityPercent()).toBeLessThan(5);
	});

	it('takes its own stop after a change', () => {
		const session = openLite(small, { ...ONE, resettle: { every: 5, patience: 1 } });
		try {
			const before = session.iterations;
			session.setRange(0, 'AA,KK,QQ,AKs,AQs,KQs,76s');
			expect((session.iterations - before) % 5).toBe(0);
			expect(session.current.solution.stoppedAt).toBe('settled');
		} finally {
			session.close();
		}
	});

	it('refines the range it stands on', () => {
		const session = openLite(small, { ...ONE, sampling: false });
		try {
			const settled = session.iterations;
			const before = session.current.solution.exploitabilityPercent();
			const refined = session.refine(100);
			expect(session.iterations).toBe(settled + 100);
			expect(refined).toBe(session.current);
			expect(refined.solution.stoppedAt).toBe('iterations');
			expect(refined.solution.exploitabilityPercent()).toBeLessThan(before);
			expect(() => session.refine(0)).toThrow(/refine/);
		} finally {
			session.close();
		}
	});

	it('refuses a hand it has no storage for, and keeps what it had', () => {
		const session = openLite(small, ONE);
		try {
			const before = session.current;
			const iterations = session.iterations;
			expect(() => session.setRange(0, WIDE)).toThrow(/oopReserve/);
			expect(session.current).toBe(before);
			expect(session.iterations).toBe(iterations);
			expect(before.source).toBe(small);
		} finally {
			session.close();
		}
	});

	it('refuses compressRanges', () => {
		expect(() => openLite(small, { ...ONE, compressRanges: true })).toThrow(/compressRanges/);
	});
});
