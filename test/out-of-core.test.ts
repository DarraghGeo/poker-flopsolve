/**
 * Out-of-core river storage (`SolveOptions.outOfCore`, issue #55): the river
 * paged through a file solves the same spot to the same answer as storage in
 * memory, reads the same strategies back, and refuses what it cannot page.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRun, defineSpot, NodeKind } from '../src/index.ts';
import { Mode } from '../src/cfr.ts';
import type { Precision, SolveOptions, SpotConfig } from '../src/index.ts';
import { openPageFile, outOfCore } from '../src/out-of-core.ts';
import type { PageFile } from '../src/out-of-core.ts';

const dir = mkdtempSync(join(tmpdir(), 'ooc-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const pageFile = () => openPageFile(join(dir, `river-${files++}.bin`));

/** A page file in memory, which counts what is asked of it. */
function memoryFile(): PageFile & { bytes: Uint8Array } {
	const file = {
		bytes: new Uint8Array(0),
		read(buffer: Uint8Array, { at }: { at: number }) {
			buffer.set(file.bytes.subarray(at, at + buffer.length));
			return Math.min(buffer.length, Math.max(0, file.bytes.length - at));
		},
		write(buffer: Uint8Array, { at }: { at: number }) {
			file.bytes.set(buffer, at);
			return buffer.length;
		},
		truncate(size: number) {
			const next = new Uint8Array(size);
			next.set(file.bytes.subarray(0, size));
			file.bytes = next;
		},
		flush() {},
	};
	return file;
}

const rainbow: SpotConfig = {
	board: 'As Kh 7d', pot: 60, stack: 100,
	oop: 'AA,KK,77,AKs,AQs,KQs,QJs,T9s', ip: 'QQ,JJ,TT,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.5]], maxRaises: 2,
};
// Monotone: mirror-image runouts are stored once and hands packed by orbit.
const monotone: SpotConfig = { ...rainbow, board: 'Ks 9s 4s', betSizes: [[0.66]], maxRaises: 1 };

interface Result {
	exploitability: number;
	evs: [Float64Array, Float64Array];
	/** Every decision's strategy on every board, concatenated. */
	strategies: Float64Array;
}

function solveWith(config: SpotConfig, iterations: number, options: SolveOptions): Result {
	const run = createRun(defineSpot(config), { workers: 1, engine: 'js', ...options });
	try {
		run.step(iterations);
		const snapshot = run.snapshot();
		const { tree, runouts } = run.spot;
		const parts: number[] = [];
		for (const node of tree.decisionNodes) {
			for (let board = 0; board < runouts.counts[tree.round[node]]; board++) {
				for (const p of snapshot.strategyAt(node, board).probs) parts.push(p);
			}
		}
		return {
			exploitability: run.exploitabilityPercent(),
			evs: [snapshot.handEvs(0), snapshot.handEvs(1)],
			strategies: Float64Array.from(parts),
		};
	} finally {
		run.close();
	}
}

/** Index of the first entry that differs, or -1; -2 for a length mismatch. */
function firstDifference(a: Float64Array, b: Float64Array): number {
	if (a.length !== b.length) return -2;
	for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i;
	return -1;
}

describe('out-of-core river storage', () => {
	it('is off by default', () => {
		const run = createRun(defineSpot(rainbow), { workers: 1 });
		expect(run.solver.ctx.pager ?? null).toBeNull();
		expect(run.outOfCore()).toBeNull();
		run.close();
	});

	for (const [name, config] of [['rainbow', rainbow], ['monotone', monotone]] as const) {
		for (const algorithm of ['dcfr', 'cfr+'] as const) {
			it(`at 32 bits is the in-memory solve, bit for bit (${name}, ${algorithm})`, () => {
				const memory = solveWith(config, 10, { precision: 'f32', algorithm });
				const file = pageFile();
				try {
					const paged = solveWith(config, 10, { precision: 'f32', algorithm, outOfCore: outOfCore(file) });
					expect(paged.exploitability).toBe(memory.exploitability);
					expect(firstDifference(paged.evs[0], memory.evs[0])).toBe(-1);
					expect(firstDifference(paged.evs[1], memory.evs[1])).toBe(-1);
					expect(firstDifference(paged.strategies, memory.strategies)).toBe(-1);
				} finally {
					file.close();
				}
			});
		}
	}

	it('at 16 bits converges with the in-memory 16-bit solve', () => {
		// The rounding dither is keyed by position in a page, not in storage,
		// so the two runs round differently; both should land in the same place.
		const memory = solveWith(monotone, 150, { precision: 'i16' });
		const paged = solveWith(monotone, 150, { precision: 'i16', outOfCore: outOfCore(memoryFile()) });
		expect(memory.exploitability).toBeLessThan(0.5);
		expect(Math.abs(paged.exploitability - memory.exploitability)).toBeLessThan(0.1);
		for (const player of [0, 1]) {
			let largest = 0;
			for (let combo = 0; combo < paged.evs[player].length; combo++) {
				largest = Math.max(largest, Math.abs(paged.evs[player][combo] - memory.evs[player][combo]));
			}
			// Chips, against a pot of 60: well under 1% of it.
			expect(largest).toBeLessThan(0.3);
		}
	});

	it('keeps only the trunk and one page in memory, and reads and writes the river once per pass', () => {
		const file = memoryFile();
		const spot = defineSpot(rainbow);
		const run = createRun(spot, { workers: 1, outOfCore: outOfCore(file), precision: 'f32' as Precision });
		const report = () => run.outOfCore()!;
		expect(report().fileBytes).toBe(file.bytes.length);
		expect(report().residentBytes).toBeLessThan(spot.estimate.bytes / 4);
		// Exactly the river: everything in memory storage but the trunk.
		const memory = createRun(spot, { workers: 1, precision: 'f32', engine: 'js' });
		const trunk = run.solver.ctx.layout.totalSlots;
		expect(report().fileBytes).toBe((memory.solver.ctx.layout.totalSlots - trunk) * 4 * 2);
		memory.close();
		run.step(1);
		const { bytesRead, bytesWritten, pageLoads } = report();
		// Per traversal every page is loaded once: regrets read in full, one
		// player's sums read; that player's half of both written back.
		const pages = 2 * spot.runouts.counts[1] * countTurnChanceNodes(spot.tree.kind, spot.tree.round);
		expect(pageLoads).toBe(pages);
		expect(bytesRead).toBeLessThan(file.bytes.length * 2);
		expect(bytesRead).toBeGreaterThan(file.bytes.length);
		expect(bytesWritten).toBeLessThanOrEqual(file.bytes.length);
		run.close();
	});

	it('reads values at a river terminal without paging, and recovers from a failed read', () => {
		const file = memoryFile();
		const spot = defineSpot(rainbow);
		const run = createRun(spot, { workers: 1, outOfCore: outOfCore(file), precision: 'f32' });
		run.step(2);
		const { tree } = spot;
		let terminal = -1;
		for (let node = 0; node < tree.nodeCount && terminal < 0; node++) {
			if (tree.round[node] === 2 && tree.kind[node] === NodeKind.TerminalFold) terminal = node;
		}
		const reach = new Float64Array(1326).fill(1);
		const live = Uint16Array.from(spot.players[0].combos);
		expect(() => run.solver.valuesAt(terminal, 0, 0, reach, reach, live, live.length)).not.toThrow();

		// A read that fails must not leave its range marked as loaded. Training
		// player 0 reads, on the first page, both players' regrets and then
		// player 0's sums: fail that third read, then read a player-0
		// strategy on that same page, which must come from the file.
		const plan = run.solver.ctx.pager!.plan;
		const node = Array.from(plan.nodes.subarray(plan.nodeStart[0], plan.nodeStart[1])).find((n) => tree.player[n] === 0)!;
		const board = spot.runouts.childStart[2][0];
		const expected = run.snapshot().strategyAt(node, board).probs;
		// Leave that page, so training reads it in again first thing.
		const groups = plan.nodeStart.length - 1;
		const elsewhere = plan.nodes[plan.nodeStart[groups - 1]];
		run.snapshot().strategyAt(elsewhere, spot.runouts.counts[2] - 1);
		const read = file.read;
		let reads = 0;
		file.read = (buffer, options) => {
			if (++reads === 3) throw new Error('transient');
			return read(buffer, options);
		};
		expect(() => run.step(1)).toThrow(/transient/);
		file.read = read;
		expect(firstDifference(run.snapshot().strategyAt(node, board).probs, expected)).toBe(-1);
		run.close();
	});

	it('writes the resident page back on close', () => {
		const file = memoryFile();
		const spot = defineSpot(monotone);
		const run = createRun(spot, { workers: 1, outOfCore: outOfCore(file), precision: 'f32' });
		run.step(3);
		const written = run.outOfCore()!.bytesWritten;
		run.close();
		expect(run.outOfCore()!.bytesWritten).toBeGreaterThan(written);
	});

	it('mirrors the traversal modes it hard-codes', () => {
		// paging.ts may not import cfr.ts's values, so it repeats these.
		expect(Mode.Train).toBe(0);
		expect(Mode.Current).toBe(3);
	});

	it('refuses what it cannot page', () => {
		const file = () => outOfCore(memoryFile());
		const turn = defineSpot({ ...rainbow, board: 'As Kh 7d 2c' });
		expect(() => createRun(turn, { outOfCore: file() })).toThrow(/flop/);
		const spot = defineSpot(rainbow);
		expect(() => createRun(spot, { outOfCore: file(), analysisOnly: true })).toThrow(/analysisOnly/);
		expect(() => createRun(spot, { outOfCore: file(), approximations: { chanceSampling: {} } })).toThrow(
			/chanceSampling/,
		);
		const bucketed = defineSpot({ ...rainbow, runoutBuckets: 3 });
		expect(bucketed.runouts.approximate).toBe(true);
		expect(() => createRun(bucketed, { outOfCore: file() })).toThrow(/runoutBuckets/);
		const paged = createRun(spot, { workers: 1, outOfCore: file() });
		paged.step(1);
		expect(() => createRun(spot, { warmStart: paged.snapshot() })).toThrow(/outOfCore/);
		paged.close();
	});
});

function countTurnChanceNodes(kind: Uint8Array, round: Uint8Array): number {
	let count = 0;
	for (let node = 0; node < kind.length; node++) if (kind[node] === NodeKind.Chance && round[node] === 0) count++;
	return count;
}
