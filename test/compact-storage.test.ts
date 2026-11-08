/**
 * Compact storage (`SpotConfig.compactStorage`, issue #50): later rounds keep
 * 8-bit regrets and no strategy sums, and play the current profile. With
 * 32-bit regrets kept it trains exactly as the full solve; at 8 bits it still
 * converges; unset, nothing changes.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, SpotTooLargeError } from '../src/index.ts';
import type { CompactStorage, SolveOptions, SpotConfig } from '../src/index.ts';

const flop: SpotConfig = {
	board: 'Ts 9s 4h', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};

const withStorage = (compactStorage: CompactStorage): SpotConfig => ({ ...flop, compactStorage });

/** Each decision node's slots, in storage order, as [node, start, length]. */
function slices(run: ReturnType<typeof createRun>, compact: boolean): [number, number, number][] {
	const { tree } = run.spot;
	const layout = run.solver.ctx.layout;
	const nodes = Array.from(tree.decisionNodes).filter((n) => (tree.round[n] >= layout.compactFrom) === compact);
	nodes.sort((a, b) => layout.offset[a] - layout.offset[b]);
	const end = compact ? layout.compactSlots : layout.totalSlots;
	return nodes.map((n, k) => [n, layout.offset[n], (k + 1 < nodes.length ? layout.offset[nodes[k + 1]] : end) - layout.offset[n]]);
}

describe('compact storage', () => {
	it('is off by default', () => {
		const spot = defineSpot(flop);
		expect(spot.estimate.compactBytes).toBeNull();
		const run = createRun(spot, { workers: 1 });
		expect(run.solver.ctx.layout.compactSlots).toBe(0);
		expect(run.solver.ctx.compactRegret ?? null).toBeNull();
		run.close();
	});

	for (const algorithm of ['dcfr', 'cfr+'] as const) {
		it(`with 32-bit regrets trains exactly as the full solve (${algorithm})`, () => {
			const exact = createRun(defineSpot(flop), { workers: 1, engine: 'js', algorithm });
			const compact = createRun(defineSpot(withStorage({ from: 1, float: true })), { workers: 1, algorithm });
			exact.step(15);
			compact.step(15);
			expect(compact.engine).toBe('js');
			// Flop nodes: same regrets and sums; later nodes: same regrets.
			const flopNodes = slices(compact, false);
			const exactSlots = new Map(slices(exact, false).concat(slices(exact, true)).map(([n, s, l]) => [n, [s, l]]));
			for (const [node, start, length] of flopNodes) {
				const [from, len] = exactSlots.get(node)!;
				expect(len).toBe(length);
				for (let i = 0; i < length; i++) {
					expect(compact.solver.ctx.regret[start + i]).toBe(exact.solver.ctx.regret[from + i]);
					expect(compact.solver.ctx.strategySum[start + i]).toBe(exact.solver.ctx.strategySum[from + i]);
				}
			}
			let differences = 0;
			for (const [node, start, length] of slices(compact, true)) {
				const [from, len] = exactSlots.get(node)!;
				expect(len).toBe(length);
				for (let i = 0; i < length; i++) {
					const chunk = compact.solver.ctx.layout.compactChunk![node];
					if (compact.solver.ctx.compactRegret![chunk][start + i] !== exact.solver.ctx.regret[from + i]) differences++;
				}
			}
			expect(differences).toBe(0);
			// The root plays the average strategy, as before.
			expect(Array.from(compact.snapshot().strategyAt(0, 0).probs)).toEqual(Array.from(exact.snapshot().strategyAt(0, 0).probs));
			exact.close();
			compact.close();
		});
	}

	it('reads the current profile where it keeps no sums', () => {
		const run = createRun(defineSpot(withStorage({ from: 1 })), { workers: 1 });
		run.step(10);
		const { tree } = run.spot;
		const river = tree.decisionNodes.find((n) => tree.round[n] === 2)!;
		const view = run.snapshot().strategyAt(river, 0);
		const actions = view.actions.length;
		for (let i = 0; i < view.combos.length; i++) {
			let total = 0;
			for (let a = 0; a < actions; a++) total += view.probs[i * actions + a];
			expect(total).toBeCloseTo(1, 12);
		}
		run.close();
	});

	it('at 8 bits converges about as the full solve does', () => {
		const exact = createRun(defineSpot(flop), { workers: 1, engine: 'js' });
		const compact = createRun(defineSpot(withStorage({})), { workers: 1 });
		exact.step(150);
		compact.step(150);
		const full = exact.exploitabilityPercent();
		const small = compact.exploitabilityPercent();
		// The current profile is about twice as exploitable as the average at
		// equal iterations, and rounding adds a floor well under 0.3% of pot.
		expect(small).toBeLessThan(0.3);
		expect(small).toBeLessThan(full * 4 + 0.05);
		const ev = exact.snapshot().ev(0);
		expect(Math.abs(compact.snapshot().ev(0) - ev)).toBeLessThan(0.01 * flop.pot);
		exact.close();
		compact.close();
	});

	for (const blockScale of [false, true]) {
		it(`splits into chunks without changing anything (${blockScale ? 'block' : 'hand'} scale)`, () => {
			const whole = createRun(defineSpot(withStorage({ blockScale })), { workers: 1 });
			const split = createRun(defineSpot(withStorage({ blockScale, chunkBytes: 100_000 })), { workers: 1 });
			expect(whole.solver.ctx.compactRegret!.length).toBe(1);
			const chunks = split.solver.ctx.compactRegret!.length;
			expect(chunks).toBeGreaterThan(3);
			for (const chunk of split.solver.ctx.compactRegret!) expect(chunk.byteLength).toBeLessThanOrEqual(100_000);
			whole.step(12);
			split.step(12);
			const flat = (run: typeof whole): number[] => run.solver.ctx.compactRegret!.flatMap((chunk) => Array.from(chunk));
			expect(flat(split)).toEqual(flat(whole));
			if (!blockScale) {
				const shifts = (run: typeof whole): number[] => run.solver.ctx.handShift!.flatMap((chunk) => Array.from(chunk));
				expect(shifts(split)).toEqual(shifts(whole));
			}
			expect(split.exploitabilityPercent()).toBe(whole.exploitabilityPercent());
			whole.close();
			split.close();
		});
	}

	it('gives the same answer on worker threads', () => {
		const one = createRun(defineSpot(withStorage({})), { workers: 1 });
		const two = createRun(defineSpot(withStorage({})), { workers: 2 });
		expect(two.workers).toBe(2);
		one.step(30);
		two.step(30);
		// Threads sum runouts in another order, and rounding at random
		// amplifies that, so the two agree only as closely as two solves do.
		const a = one.exploitabilityPercent();
		const b = two.exploitabilityPercent();
		expect(Math.abs(a - b)).toBeLessThan(0.15 * a);
		one.close();
		two.close();
	});

	it('takes far less memory, and maxBytes is checked against it', () => {
		const spot = defineSpot(withStorage({}));
		const { totalSlots, compressedBytes, compactBytes } = spot.estimate;
		// A byte per slot and a byte per hand: under 1.5 bytes a slot here,
		// where 16-bit storage takes 4 and 32-bit 8, beside showdown tables.
		const run = createRun(spot, { workers: 1 });
		const { layout } = run.solver.ctx;
		run.close();
		expect(layout.totalSlots).toBe(0);
		expect(layout.compactSlots).toBe(totalSlots);
		expect(layout.bytes).toBe(totalSlots + layout.compactHands);
		expect(layout.bytes).toBeLessThanOrEqual(totalSlots * 1.5);
		expect(compactBytes!).toBeLessThan(compressedBytes);
		expect(() => defineSpot({ ...flop, maxBytes: compactBytes! })).toThrow(SpotTooLargeError);
		expect(defineSpot(withStorage({})).estimate.fits).toBe(true);
		expect(() => defineSpot({ ...withStorage({}), maxBytes: compactBytes! })).not.toThrow();
		expect(() => defineSpot({ ...withStorage({}), maxBytes: compactBytes! - 1 })).toThrow(SpotTooLargeError);
	});

	it('refuses what it does not combine with', () => {
		const spot = defineSpot(withStorage({}));
		const clashes: SolveOptions[] = [
			{ precision: 'i16' }, { analysisOnly: true },
			{ approximations: { chanceSampling: { p: 0.5 } } }, { approximations: { coarseStart: { iterations: 5 } } },
		];
		for (const options of clashes) expect(() => createRun(spot, { workers: 1, ...options })).toThrow(/compactStorage/);
		expect(() => defineSpot(withStorage({ from: 3 }))).toThrow(/from/);
		expect(() => defineSpot(withStorage({ steps: 200 }))).toThrow(/steps/);
	});
});
