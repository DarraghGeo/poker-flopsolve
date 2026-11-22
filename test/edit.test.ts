/**
 * `SolveRun.edit` and `SolveRun.preview`: changing a run's pot, stack or
 * betting behind the same run, started from what it has learnt.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import type { SolveOptions, SolveRun, SpotConfig, SpotEdit } from '../src/index.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const river: SpotConfig = { board: 'AsKh7d2c9h', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.33, 0.75]], maxRaises: 2 };
const turn: SpotConfig = { ...river, board: 'AsKh7d2c', maxRaises: 1 };
const ONE: SolveOptions = { workers: 1, precision: 'f64' };

const EDITS: [string, SpotEdit][] = [
	['a size nudged', { betSizes: [[0.33, 0.85]] }],
	['a size added', { betSizes: [[0.33, 0.75, 1.25]] }],
	['a size removed', { betSizes: [[0.75]] }],
	['one more raise', { maxRaises: 3 }],
	['another pot and stack', { pot: 72, stack: 150 }],
];

/** Iterations until exploitability is at or under `target`, checked every few. */
function iterationsTo(run: SolveRun, target: number, cap = 400): number {
	const start = run.completed;
	while (run.completed - start < cap) {
		run.step(5);
		if (run.exploitabilityPercent() <= target) return run.completed - start;
	}
	return Infinity;
}

describe('edit', () => {
	it.each(EDITS)('puts the run on the edited spot and solves it sooner than a new run: %s', (_, changes) => {
		const run = createRun(defineSpot(river), ONE);
		const cold = createRun(defineSpot({ ...river, ...changes }), ONE);
		try {
			iterationsTo(run, 0.3);
			const before = { solver: run.solver, completed: run.completed };
			run.edit(changes);
			expect(run.solver).not.toBe(before.solver);
			expect(run.spot.tree.decisionNodes.length).toBe(cold.spot.tree.decisionNodes.length);
			expect(run.spot.source).toMatchObject(changes);
			expect(run.completed).toBe(before.completed);
			expect(run.totalIterations).toBe(10);
			expect(run.warmStart).toMatchObject({ regrets: true, averages: true });
			// Seeded, it starts far nearer than a run with nothing.
			expect(run.exploitabilityPercent()).toBeLessThan(cold.exploitabilityPercent() / 2);
			const warm = iterationsTo(run, 0.3);
			expect(warm).toBeLessThanOrEqual(iterationsTo(cold, 0.3));
			run.step(60);
			cold.step(60);
			expect(Math.abs(run.snapshot().ev(0) - cold.snapshot().ev(0))).toBeLessThan(0.15);
			expect(run.snapshot().iterations).toBe(run.completed);
		} finally {
			run.close();
			cold.close();
		}
	});

	it('seeds a size the tree did not have from its neighbour, and a new raise from nothing', () => {
		const run = createRun(defineSpot(river), ONE);
		try {
			run.step(30);
			run.edit({ betSizes: [[0.33, 0.75, 1.25]] });
			// Every decision under the new size stands on one under 0.75; only raises the old tree had none of are new.
			const total = run.spot.tree.decisionNodes.length;
			expect(run.warmStart!.matchedNodes).toBeGreaterThan(14);
			expect(run.warmStart!.matchedNodes).toBeLessThanOrEqual(total);
			const root = run.snapshot().strategyAt(0, 0);
			expect(root.actions.length).toBe(4);
			// The new size plays as its neighbour did until iterations tell them apart.
			const [near, added] = [root.actions.indexOf('bet 45'), root.actions.indexOf('bet 75')];
			expect(near).toBeGreaterThan(0);
			expect(added).toBeGreaterThan(0);
			for (let i = 0; i < root.combos.length; i++) {
				expect(root.probs[i * 4 + added]).toBeCloseTo(root.probs[i * 4 + near], 9);
			}
		} finally {
			run.close();
		}
	});

	it('keeps the ranges the run holds, grown or changed in place', () => {
		const run = createRun(defineSpot(river), ONE);
		try {
			run.step(20);
			run.setRange(0, `${OOP},76s`);
			run.setRange(1, 'TT-22,AQs-A2s,KQs');
			const hands = [run.spot.players[0].count, run.spot.players[1].count];
			const weights = Array.from(run.spot.players[1].weights);
			run.edit({ pot: 80 });
			expect([run.spot.players[0].count, run.spot.players[1].count]).toEqual(hands);
			expect(Array.from(run.spot.players[1].weights)).toEqual(weights);
			expect(run.spot.source.pot).toBe(80);
			expect(iterationsTo(run, 0.5)).toBeLessThan(100);
		} finally {
			run.close();
		}
	});

	it.each([
		['the default engine', {}],
		['three threads', { workers: 3 }],
		['16-bit storage', { workers: 1, precision: 'i16' }],
		['CFR+', { workers: 1, algorithm: 'cfr+' }],
	] as const)('works on %s', (_, given) => {
		const options: SolveOptions = given;
		const run = createRun(defineSpot(turn), options);
		const cold = createRun(defineSpot({ ...turn, betSizes: [[0.33, 0.9]] }), options);
		try {
			run.step(40);
			const total = run.totalIterations;
			const { workers } = run;
			run.edit({ betSizes: [[0.33, 0.9]] });
			expect(run.workers).toBe(workers);
			// CFR+ keeps its count and takes no average: it would never let go of it.
			expect(run.totalIterations).toBe(options.algorithm === 'cfr+' ? total : 10);
			expect(run.warmStart!.averages).toBe(options.algorithm !== 'cfr+');
			expect(run.exploitabilityPercent()).toBeLessThan(cold.exploitabilityPercent() / 2);
			run.step(60);
			expect(run.exploitabilityPercent()).toBeLessThan(1);
		} finally {
			run.close();
			cold.close();
		}
	});

	it('keeps threads waiting for the run it becomes next, and lets them go when it closes', () => {
		const pool = (): { idle: unknown[]; reserved: number } =>
			(globalThis as unknown as Record<symbol, { idle: unknown[]; reserved: number }>)[Symbol.for('poker-flopsolve.node-engine-threads')];
		const run = createRun(defineSpot({ ...turn, board: 'Ts9s4h2c' }), { workers: 3 });
		const reserved = pool().reserved;
		try {
			expect(run.workers).toBe(3);
			run.step(10);
			for (const changes of [{ pot: 70 }, { betSizes: [[0.5]] }, { maxRaises: 2 }]) {
				run.edit(changes);
				expect(run.workers).toBe(3);
				// Once replaced, it has two threads of its own waiting for the next time.
				expect(pool().reserved).toBe(reserved + 2);
				expect(pool().idle.length).toBeGreaterThanOrEqual(2);
				run.step(5);
			}
			expect(Number.isFinite(run.exploitabilityPercent())).toBe(true);
		} finally {
			run.close();
			run.close();
		}
		expect(pool().reserved).toBe(reserved);
	});

	it('changes nothing when the edited spot cannot be, and refuses what it cannot carry', () => {
		const run = createRun(defineSpot(river), ONE);
		const loaded = createRun(defineSpot(river), { analysisOnly: true });
		try {
			run.step(10);
			const { solver } = run;
			const before = run.exploitabilityPercent();
			expect(() => run.edit({ pot: -1 })).toThrow(/pot/);
			expect(() => run.edit({ pot: 70 }, { resume: -1 })).toThrow(/resume/);
			expect(run.solver).toBe(solver);
			expect(run.exploitabilityPercent()).toBe(before);
			expect(() => loaded.edit({ pot: 70 })).toThrow(/analysisOnly/);
		} finally {
			run.close();
			loaded.close();
		}
	});
});

describe('preview', () => {
	it.each(EDITS)('shows the strategy the edited run starts from, without changing the run: %s', (_, changes) => {
		const run = createRun(defineSpot(turn), ONE);
		try {
			run.step(30);
			const { solver, spot } = run;
			const before = run.exploitabilityPercent();
			const preview = run.preview(changes);
			expect(run.solver).toBe(solver);
			expect(run.spot).toBe(spot);
			expect(run.exploitabilityPercent()).toBe(before);
			expect(preview.spot.source).toMatchObject(changes);

			const views = Array.from(preview.spot.tree.decisionNodes).slice(0, 12).map((node) => preview.strategyAt(node, 0));
			run.edit(changes);
			expect(run.spot.tree.decisionNodes.length).toBe(preview.spot.tree.decisionNodes.length);
			expect(run.warmStart!.matchedNodes).toBe(preview.seededNodes);
			const seeded = run.snapshot();
			for (const view of views) {
				const own = seeded.strategyAt(view.node, 0);
				expect(own.actions).toEqual(view.actions);
				// Each hand's mix sums to one, and is the edited run's own before it runs.
				for (let i = 0; i < view.combos.length; i++) {
					let sum = 0;
					for (let e = 0; e < view.actions.length; e++) sum += view.probs[i * view.actions.length + e];
					expect(sum).toBeCloseTo(1, 9);
				}
				for (let k = 0; k < view.probs.length; k++) expect(view.probs[k]).toBeCloseTo(own.probs[k], 5);
			}
		} finally {
			run.close();
		}
	});
});

describe('preview, refused', () => {
	it('has none for an edit that changes which hands or runouts are stored', () => {
		const run = createRun(defineSpot({ ...turn, oop: `${OOP},65s:0.01` }), ONE);
		try {
			run.step(5);
			expect(() => run.preview({ minWeight: 0.05 })).toThrow(/edit it instead/);
			expect(() => run.preview({ runoutBuckets: 3 })).toThrow(/edit it instead/);
			// The edit itself is taken: the regrets are carried hand by hand, board by board.
			run.edit({ minWeight: 0.05 });
			run.step(5);
			expect(Number.isFinite(run.exploitabilityPercent())).toBe(true);
		} finally {
			run.close();
		}
	});
});

describe('warmTolerance', () => {
	it('seeds a size the old tree lacked only when asked to', () => {
		const before = createRun(defineSpot(river), ONE);
		before.step(20);
		const wider = defineSpot({ ...river, betSizes: [[0.33, 0.75, 1.25]] });
		const strict = createRun(wider, { ...ONE, warmStart: before });
		const loose = createRun(wider, { ...ONE, warmStart: before, warmTolerance: Infinity });
		try {
			expect(strict.warmStart!.matchedNodes).toBeLessThan(loose.warmStart!.matchedNodes);
			expect(loose.exploitabilityPercent()).toBeLessThan(strict.exploitabilityPercent());
		} finally {
			before.close();
			strict.close();
			loose.close();
		}
	});
});
