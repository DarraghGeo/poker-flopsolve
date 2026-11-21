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

	it('takes a range it has no storage for, on a new run started from the old one', () => {
		const session = openLite(small, { ...ONE, sampling: false });
		try {
			const opened = session.iterations;
			const stored = session.current.solution.spot.players[0].count;
			const warm = session.setRange(0, WIDE);
			const cold = solveLite({ ...small, oop: WIDE }, { ...ONE, sampling: false });
			expect(warm.solution.spot.players[0].count).toBeGreaterThan(stored);
			expect(warm.solution.iterations).toBe(session.iterations);
			expect(warm.solution.stoppedAt).toBe('settled');
			expect(warm.source.oop).toBe(WIDE);
			expect(session.iterations).toBeGreaterThan(opened);
			// Three classes onto eight is most of a new game on a spot this small: only that it lands where a new solve does.
			expect(Math.abs(warm.solution.ev(0) - cold.solution.ev(0))).toBeLessThan(0.5);
			expect(warm.solution.exploitabilityPercent()).toBeLessThan(cold.solution.exploitabilityPercent() * 1.2);
			// The wider hands are stored now, so the way back is in place.
			const run = warm.solution.solver;
			expect(session.setRange(0, small.oop as string).solution.solver).toBe(run);
			// A range that breaks the blueprint's symmetry gets a new run too.
			const lopsided = session.setRange(0, `${small.oop as string},AdQc`);
			expect(lopsided.solution.solver).not.toBe(run);
			expect(lopsided.solution.spot.players[0].weights[parseRange('AdQc').findIndex((w) => w > 0)]).toBe(1);
		} finally {
			session.close();
		}
	});

	it('refuses an unplayable range on the way to a new run too, and keeps what it had', () => {
		const session = openLite({ ...small, oop: 'AA,KK,QQ,AKs', ip: 'AsKs' }, ONE);
		try {
			const before = session.current;
			const run = before.solution.solver;
			// Not stored, so it would need a new run; and no hand of it can face As Ks.
			expect(() => session.setRange(0, 'AsQs')).toThrow(/held against/);
			expect(session.current).toBe(before);
			expect(Number.isFinite(session.refine(5).solution.ev(0))).toBe(true);
			expect(session.current.solution.solver).toBe(run);
		} finally {
			session.close();
		}
	});

	it('keeps every hand a run stored when it gets a new one', () => {
		const session = openLite(small, { ...ONE, sampling: false });
		try {
			const stored = (): number => session.current.solution.spot.players[0].count;
			const opened = stored();
			session.setRange(0, WIDE);
			const wide = stored();
			expect(wide).toBeGreaterThan(opened);
			session.setRange(0, 'AA,KK,AKs');
			expect(stored()).toBe(wide);
			// A new hand again: a new run, with the wide hands still stored.
			const run = session.current.solution.solver;
			session.setRange(0, 'AA,KK,AKs,A5s');
			expect(session.current.solution.solver).not.toBe(run);
			expect(stored()).toBe(wide + 4);
			const again = session.current.solution.solver;
			expect(session.setRange(0, WIDE).solution.solver).toBe(again);
		} finally {
			session.close();
		}
	});

	it('still refuses a range nobody can play, and keeps what it had', () => {
		const session = openLite(small, ONE);
		try {
			const before = session.current;
			const iterations = session.iterations;
			expect(() => session.setRange(0, 'Ts9h')).toThrow(/empty/);
			expect(session.current).toBe(before);
			expect(session.iterations).toBe(iterations);
			expect(before.source).toBe(small);
		} finally {
			session.close();
		}
	});

	it('compresses the ranges again at every move', () => {
		const wide: SpotConfig = {
			...small,
			oop: 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo',
			ip: 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo',
		};
		const options = { ...ONE, compressRanges: { tolerance: 0.02 } } as const;
		const session = openLite(wide, options);
		try {
			const next = `${wide.oop as string},76s,65s,QJo`;
			const warm = session.setRange(0, next);
			const cold = solveLite({ ...wide, oop: next }, options);
			expect(warm.solution.stoppedAt).toBe('settled');
			expect(warm.solution.iterations).toBe(session.iterations);
			// The blueprint holds the new range compressed, as a new solveLite's does.
			expect(Array.from(warm.solution.spot.players[0].weights)).toEqual(Array.from(cold.solution.spot.players[0].weights));
			expect(Array.from(warm.solution.spot.players[1].weights)).toEqual(Array.from(cold.solution.spot.players[1].weights));
			expect(warm.solution.spot.players[0].count).toBeLessThan(parseRange(next).filter((w) => w > 0).length);
			expect(Math.abs(warm.solution.ev(0) - cold.solution.ev(0))).toBeLessThan(1);
			expect(warm.source.oop).toBe(next);
		} finally {
			session.close();
		}
	});

	it('follows a range under CFR+', () => {
		const options = { ...ONE, sampling: false, algorithm: 'cfr+' } as const;
		const session = openLite({ ...small, oopReserve: WIDE }, options);
		try {
			const opened = session.iterations;
			const warm = session.setRange(0, WIDE);
			const cold = solveLite({ ...small, oopReserve: WIDE, oop: WIDE }, options);
			expect(warm.solution.stoppedAt).toBe('settled');
			expect(session.iterations - opened).toBeLessThanOrEqual(cold.solution.iterations);
			expect(Math.abs(warm.solution.ev(0) - cold.solution.ev(0))).toBeLessThan(0.5);
			expect(warm.solution.exploitabilityPercent()).toBeLessThan(cold.solution.exploitabilityPercent() * 1.5);
		} finally {
			session.close();
		}
	});

	it('stops on a target and reports progress without a settle rule, as solveLite does', () => {
		const seen: number[] = [];
		const options = { workers: 1, settle: false, iterations: 300, targetPercent: 50, onProgress: (info: { iteration: number }) => seen.push(info.iteration) } as const;
		const session = openLite(small, options);
		try {
			const lite = solveLite(small, { ...options, onProgress: undefined });
			expect(session.current.solution.stoppedAt).toBe('target');
			expect(session.iterations).toBe(lite.solution.iterations);
			expect(seen.length).toBeGreaterThan(0);
			const before = session.iterations;
			expect(session.setRange(0, 'AA,KK,QQ,AKs,AQs,KQs,76s').solution.stoppedAt).toBe('target');
			expect(session.iterations - before).toBeLessThan(300);
		} finally {
			session.close();
		}
	});

	it('settles the moves by resettle alone when the first solve runs to a cap', () => {
		const session = openLite(small, { workers: 1, settle: false, iterations: 300, resettle: { every: 10 } });
		try {
			expect(session.current.solution.stoppedAt).toBe('iterations');
			expect(session.iterations).toBe(300);
			expect(session.setRange(0, 'AA,KK,QQ,AKs,AQs,KQs,76s').solution.stoppedAt).toBe('settled');
			expect(session.iterations).toBeLessThan(600);
		} finally {
			session.close();
		}
	});

	it('refuses a bad resettle before solving, and keeps current true to the range if settling fails', () => {
		expect(() => openLite(small, { ...ONE, resettle: { every: 0 } })).toThrow(/settle.every/);
		let fail = false;
		const session = openLite(small, { ...ONE, onProgress: () => {
			if (fail) throw new Error('stopped by the page');
		} });
		try {
			const before = session.current;
			fail = true;
			expect(() => session.setRange(0, 'AA,KK,QQ')).toThrow(/stopped by the page/);
			expect(session.current).not.toBe(before);
			expect(session.current.source.oop).toBe('AA,KK,QQ');
			expect(Array.from(session.current.solution.spot.players[0].weights)).toEqual(Array.from(parseRange('AA,KK,QQ')));
		} finally {
			session.close();
		}
	});

});
