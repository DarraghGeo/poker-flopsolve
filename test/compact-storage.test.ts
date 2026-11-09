/**
 * Compact storage (`SpotConfig.compactStorage`, issue #50): regrets and
 * strategy sums at 8 bits, scaled per hand; or, with `sums: false`, regrets
 * only and the current profile. With 32-bit regrets kept it trains exactly
 * as the full solve; at 8 bits it still converges; unset, nothing changes.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, SpotTooLargeError } from '../src/index.ts';
import type { CompactStorage, SolveOptions, SpotConfig } from '../src/index.ts';
import { updateCompact } from '../src/cfr.ts';

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
			const compact = createRun(defineSpot(withStorage({ from: 1, float: true, sums: false })), { workers: 1, algorithm });
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
		const run = createRun(defineSpot(withStorage({ from: 1, sums: false })), { workers: 1 });
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

	it('at 8 bits trains about as at 32', () => {
		// The current profile is far more exploitable than the average on
		// this spot either way; rounding regrets to 8 bits adds little.
		const wide = createRun(defineSpot(withStorage({ float: true, sums: false })), { workers: 1 });
		const compact = createRun(defineSpot(withStorage({ sums: false })), { workers: 1 });
		wide.step(150);
		compact.step(150);
		expect(compact.exploitabilityPercent()).toBeLessThan(wide.exploitabilityPercent() * 1.5 + 0.2);
		wide.close();
		compact.close();
	});

	it('with 8-bit sums keeps the average, and converges about as the full solve does', () => {
		const exact = createRun(defineSpot(flop), { workers: 1, engine: 'js' });
		const compact = createRun(defineSpot(withStorage({ sums: true })), { workers: 1 });
		expect(compact.solver.ctx.compactSum!.length).toBe(1);
		exact.step(150);
		compact.step(150);
		// About as exploitable as the full solve; rounding the sums leaves a
		// floor, here near 0.1% of pot.
		expect(compact.exploitabilityPercent()).toBeLessThan(exact.exploitabilityPercent() * 1.5 + 0.1);
		const ev = exact.snapshot().ev(0);
		expect(Math.abs(compact.snapshot().ev(0) - ev)).toBeLessThan(0.005 * flop.pot);
		// Strategies read the average, which no longer equals the current profile.
		const { tree } = compact.spot;
		const river = tree.decisionNodes.find((n) => tree.round[n] === 2)!;
		const ctx = compact.solver.ctx;
		const view = compact.snapshot().strategyAt(river, 0);
		const chunk = ctx.layout.compactChunk![river];
		const sums = ctx.compactSum![chunk];
		const base = ctx.layout.offset[river];
		let any = 0;
		for (let i = 0; i < view.combos.length * view.actions.length; i++) any += sums[base + i];
		expect(any).toBeGreaterThan(0);
		exact.close();
		compact.close();
	});

	for (const blockScale of [false, true]) {
		it(`splits into chunks without changing anything (${blockScale ? 'block' : 'hand'} scale)`, () => {
			const whole = createRun(defineSpot(withStorage({ blockScale, sums: false })), { workers: 1 });
			const split = createRun(defineSpot(withStorage({ blockScale, sums: false, chunkBytes: 100_000 })), { workers: 1 });
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
		const layoutOf = (storage: CompactStorage) => {
			const run = createRun(defineSpot(withStorage(storage)), { workers: 1 });
			const { layout } = run.solver.ctx;
			run.close();
			return layout;
		};
		const spot = defineSpot(withStorage({}));
		const { totalSlots, compressedBytes, compactBytes } = spot.estimate;
		// A byte per slot and a byte per hand, for regrets and again for sums,
		// where 16-bit storage takes 4 a slot and 32-bit 8; a byte per slot
		// and per hand with no sums; a byte per slot and 8 per block with a
		// block scale.
		const withSums = layoutOf({});
		expect(withSums.totalSlots).toBe(0);
		expect(withSums.compactSlots).toBe(totalSlots);
		expect(withSums.bytes).toBe(2 * (totalSlots + withSums.compactHands));
		expect(layoutOf({ sums: false }).bytes).toBe(totalSlots + withSums.compactHands);
		expect(layoutOf({ sums: false, blockScale: true }).bytes).toBe(totalSlots + withSums.blocks * 8);
		expect(compactBytes!).toBeLessThan(compressedBytes);
		expect(() => defineSpot({ ...flop, maxBytes: compactBytes! })).toThrow(SpotTooLargeError);
		expect(spot.estimate.fits).toBe(true);
		expect(() => defineSpot({ ...withStorage({}), maxBytes: compactBytes! })).not.toThrow();
		expect(() => defineSpot({ ...withStorage({}), maxBytes: compactBytes! - 1 })).toThrow(SpotTooLargeError);
	});

	it('reads current-profile EVs, which need regrets it does have', () => {
		const run = createRun(defineSpot(withStorage({})), { workers: 1, approximations: { currentProfileEv: true } });
		run.step(5);
		expect(Number.isFinite(run.snapshot().ev(0))).toBe(true);
		run.close();
	});

	it('carries over to a subgame', () => {
		const run = createRun(defineSpot(withStorage({ sums: false })), { workers: 1 });
		run.step(3);
		const { tree } = run.spot;
		const turn = tree.decisionNodes.find((n) => tree.round[n] === 1)!;
		const sub = run.snapshot().subgameAt(turn, 0);
		expect(sub.compactStorage).toEqual({ sums: false });
		run.close();
	});

	it('combines with shared histories, which point their nodes at their owner\'s compact storage', () => {
		const deep: SpotConfig = { ...flop, stack: 200, betSizes: [[0.5]], maxRaises: 1 };
		const plain = defineSpot({ ...deep, shareHistories: true });
		const both = defineSpot({ ...deep, shareHistories: true, compactStorage: {} });
		const alone = defineSpot({ ...deep, compactStorage: {} });
		expect(both.estimate.compactBytes!).toBeLessThan(alone.estimate.compactBytes!);
		const shared = createRun(plain, { workers: 1, engine: 'js' });
		const compact = createRun(both, { workers: 1 });
		expect(compact.solver.ctx.layout.shared).toBe(true);
		// Sharing has its own plateau, near 3% of pot here; compact storage reaches it.
		shared.step(80);
		compact.step(80);
		expect(compact.exploitabilityPercent()).toBeLessThan(shared.exploitabilityPercent() * 1.5 + 0.2);
		shared.close();
		compact.close();
	});

	for (const blockScale of [false, true]) {
		it(`rounds each history sharing a block with its own random stream (issue #88${blockScale ? ', block scale' : ''})`, () => {
			const deep: SpotConfig = { ...flop, stack: 200, betSizes: [[0.5]], maxRaises: 1 };
			const run = createRun(defineSpot({ ...deep, shareHistories: true, compactStorage: { sums: false, blockScale } }), { workers: 1, engine: 'js' });
			run.step(2);
			const { ctx } = run.solver;
			const { tree } = run.spot;
			const layout = ctx.layout;
			// Two histories pointing at one block of compact storage.
			const byStorage = new Map<string, number>();
			let pair: [number, number] | null = null;
			for (const node of tree.decisionNodes) {
				if (tree.round[node] < layout.compactFrom) continue;
				const key = `${layout.compactChunk![node]}:${layout.offset[node]}`;
				const owner = byStorage.get(key);
				if (owner === undefined) byStorage.set(key, node);
				else if (pair === null) pair = [owner, node];
			}
			expect(pair).not.toBeNull();
			const [a, b] = pair!;
			const actions = tree.numEdges[a];
			const board = 0;
			const listSlot = (ctx.active.roundBase[tree.round[a]] + board) * 2 + tree.player[a];
			const count = ctx.active.count[listSlot];
			const chunk = layout.compactChunk![a];
			const slotBase = layout.offset[a] + actions * layout.rowStart[listSlot];
			const block = layout.blockOffset[a] + board;
			const handBase = layout.handOffset![a] + layout.rowStart[listSlot];
			const q = ctx.compactRegret![chunk];
			const before = q.slice();
			const scaleBefore = ctx.compactScale?.slice();
			const shiftBefore = ctx.handShift?.[chunk].slice();
			// Values a third of a step apart, so stochastic rounding has room to differ.
			const restore = (): void => {
				q.set(before);
				if (scaleBefore) ctx.compactScale!.set(scaleBefore);
				if (shiftBefore) ctx.handShift![chunk].set(shiftBefore);
			};
			const encode = (node: number): Int8Array => {
				restore();
				const actionValues = Float64Array.from({ length: actions * count }, (_, k) => ((k * 7919) % 101) / 3 + 0.37);
				updateCompact(
					ctx, node, chunk, block, slotBase, handBase, actions, count, 3,
					new Float64Array(count).fill(1), new Float64Array(actions * count).fill(1 / actions),
					actionValues, new Float64Array(count),
				);
				return q.slice(slotBase, slotBase + actions * count) as Int8Array;
			};
			const first = encode(a);
			expect(encode(a)).toEqual(first);
			expect(encode(b)).not.toEqual(first);
			restore();
			run.close();
		});
	}

	it('refuses what it does not combine with', () => {
		const spot = defineSpot(withStorage({}));
		// Issue #84 lifted the other clashes; see test/wasm-storage.test.ts.
		expect(() => createRun(spot, { workers: 1, analysisOnly: true })).toThrow(/compactStorage/);
		expect(() => defineSpot(withStorage({ from: 3 }))).toThrow(/from/);
		expect(() => defineSpot(withStorage({ steps: 200 }))).toThrow(/steps/);
		expect(() => defineSpot(withStorage({ blockScale: true }))).toThrow(/sums/);
		for (const chunkBytes of [0, -1, NaN, 1.5]) expect(() => defineSpot(withStorage({ chunkBytes }))).toThrow(/chunkBytes/);
		// A node bigger than a chunk would need a buffer over the cap.
		expect(() => createRun(defineSpot(withStorage({ chunkBytes: 1000 })), { workers: 1 })).toThrow(/chunkBytes/);
	});
});
