/**
 * `largeTree` (issue #102): the opt-in preset for a tree too big for memory.
 * It only fills in settings; with it unused nothing changes.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { largeTree, wasmStorage } from '../src/wasm-storage.ts';

const flop: SpotConfig = {
	board: 'Ts 9s 4h', pot: 60, stack: 600,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.33, 0.75, 1.5]], raiseSizes: [[0.75]], allowAllIn: true, maxRaises: 2,
};

describe('largeTree', () => {
	it('sets thinSizes, 16-bit storage on the WebAssembly engine and chance sampling', () => {
		const { config, options } = largeTree(flop);
		expect(config).toEqual({ ...flop, thinSizes: true });
		expect(options).toEqual({ precision: 'i16', wasmStorage, approximations: { chanceSampling: {} } });
	});

	it('stores compactly instead when asked', () => {
		const { config, options } = largeTree(flop, { storage: 'compact' });
		expect(config).toEqual({ ...flop, thinSizes: true, compactStorage: {} });
		expect(options).toEqual({ wasmStorage, approximations: { chanceSampling: {} } });
		// A compactStorage of the caller's own is kept.
		const own = largeTree({ ...flop, compactStorage: { from: 1 } }, { storage: 'compact' });
		expect(own.config.compactStorage).toEqual({ from: 1 });
	});

	it('leaves the config it was given alone', () => {
		const given = { ...flop };
		largeTree(given, { storage: 'compact' });
		expect(given).toEqual(flop);
	});

	it('refuses a storage it does not know', () => {
		expect(() => largeTree(flop, { storage: 'f32' as never })).toThrow(/storage/);
	});

	for (const storage of ['i16', 'compact'] as const) {
		it(`solves the thinned tree, sampled, on the WebAssembly engine (${storage})`, () => {
			const { config, options } = largeTree(flop, { storage });
			const spot = defineSpot(config);
			expect(spot.tree.nodeCount).toBe(defineSpot({ ...flop, thinSizes: true }).tree.nodeCount);
			expect(spot.tree.nodeCount).toBeLessThan(defineSpot(flop).tree.nodeCount);
			const run = createRun(spot, { ...options, workers: 1 });
			try {
				expect(run.engine).toBe('wasm');
				expect(run.solver.ctx.sampling).toBeTruthy();
				expect(storage === 'i16' ? run.solver.ctx.regretScale : run.solver.ctx.compactRegret).toBeTruthy();
				run.step(20);
				const early = run.exploitabilityPercent();
				run.step(100);
				expect(run.exploitabilityPercent()).toBeLessThan(early / 2);
			} finally {
				run.close();
			}
		});
	}
});
