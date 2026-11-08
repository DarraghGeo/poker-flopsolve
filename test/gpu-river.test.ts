/**
 * The WebGPU river kernels of the #39 experiment, and their CPU twin.
 *
 * The twin — the engine's own river code looped over boards — and the GPU
 * kernels must both give what showdown and regret matching mean, computed
 * here the slow, obvious way in doubles. The GPU half runs in headless
 * Chromium on SwiftShader's CPU-emulated WebGPU, which checks correctness
 * only, and skips where there is no browser or no adapter. Last, the
 * package's own bundles must not carry any of it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SpotConfig } from '../src/index.ts';
import type { RiverLists } from '../src/gpu/river.ts';
import { createRiverCpu } from '../src/gpu/twin.ts';
import { makeBlocks, makeReach, riverFixture } from '../bench/gpu/fixture.ts';
import { bundleForBrowser, NoBrowserError, runInBrowser } from '../scripts/browser-harness.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';

/** A turn with no symmetry left, and one whose rivers keep some: packed lists. */
const SPOTS: Record<string, SpotConfig> = {
	plain: { board: 'AsKh7d2c', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.5]], maxRaises: 1 },
	packed: { board: 'Ks9s4s2s', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.5]], maxRaises: 1 },
};

/** Showdown values by definition: every opponent hand that shares no card, signed by who wins. */
function referenceShowdown(lists: RiverLists, me: 0 | 1, reach: Float32Array, scale: number): Float64Array {
	const out = new Float64Array(lists.entries);
	for (let board = 0; board < lists.boards; board++) {
		const mine = board * 2 + me;
		const theirs = board * 2 + 1 - me;
		for (let i = lists.start[mine]; i < lists.start[mine] + lists.count[mine]; i++) {
			let total = 0;
			for (let j = lists.start[theirs]; j < lists.start[theirs] + lists.count[theirs]; j++) {
				const sign = Math.sign(lists.strength[i] - lists.strength[j]);
				if (sign === 0 || reach[j] === 0) continue;
				for (let m = lists.memberStart[j]; m < lists.memberStart[j + 1]; m++) {
					const a = lists.memberA[m];
					const b = lists.memberB[m];
					if (a === lists.cardA[i] || a === lists.cardB[i] || b === lists.cardA[i] || b === lists.cardB[i]) continue;
					total += sign * reach[j];
				}
			}
			out[i] = scale * total;
		}
	}
	return out;
}

/** Regret matching by definition. */
function referenceMatch(regret: Float32Array, blocks: Int32Array): Float64Array {
	const out = new Float64Array(regret.length);
	for (let k = 0; k < blocks.length; k += 3) {
		const [base, actions, n] = [blocks[k], blocks[k + 1], blocks[k + 2]];
		for (let i = 0; i < n; i++) {
			let total = 0;
			for (let a = 0; a < actions; a++) total += Math.max(regret[base + a * n + i], 0);
			for (let a = 0; a < actions; a++) {
				out[base + a * n + i] = total > 0 ? Math.max(regret[base + a * n + i], 0) / total : 1 / actions;
			}
		}
	}
	return out;
}

/** The largest error on the traverser's entries, relative to the board's reach times the scale. */
function showdownError(lists: RiverLists, me: 0 | 1, reach: Float32Array, scale: number, got: ArrayLike<number>, want: Float64Array): number {
	let worst = 0;
	for (let board = 0; board < lists.boards; board++) {
		const theirs = board * 2 + 1 - me;
		let mass = 0;
		for (let j = lists.start[theirs]; j < lists.start[theirs] + lists.count[theirs]; j++) {
			mass += reach[j] * (lists.memberStart[j + 1] - lists.memberStart[j]);
		}
		const mine = board * 2 + me;
		for (let i = lists.start[mine]; i < lists.start[mine] + lists.count[mine]; i++) {
			worst = Math.max(worst, Math.abs(got[i] - want[i]) / (Math.abs(scale) * Math.max(mass, 1)));
		}
	}
	return worst;
}

function largest(got: ArrayLike<number>, want: Float64Array): number {
	let worst = 0;
	for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
	return worst;
}

describe('CPU twin of the engine river kernels', () => {
	for (const [name, config] of Object.entries(SPOTS)) {
		it(`gives showdown values and regret matching on the ${name} turn`, () => {
			const fixture = riverFixture(config);
			const { lists } = fixture;
			if (name === 'packed') expect(lists.packed.some((p) => p === 1)).toBe(true);
			else expect(lists.packed.every((p) => p === 0)).toBe(true);
			const decision = fixture.decisions[0];
			const { blocks, regret } = makeBlocks(lists, decision.player, decision.actions, 7);
			const cpu = createRiverCpu(lists, regret.length, lists.boards);
			for (const me of [0, 1] as const) {
				const reach = makeReach(lists, 11 + me);
				cpu.reach.set(reach);
				cpu.showdown(me, fixture.scale);
				const want = referenceShowdown(lists, me, reach, fixture.scale);
				// Double accumulators, one rounding to f32 at the end.
				expect(showdownError(lists, me, reach, fixture.scale, cpu.values, want)).toBeLessThan(1e-6);
			}
			cpu.regret.set(regret);
			cpu.setBlocks(blocks);
			cpu.regretMatch();
			expect(largest(cpu.strategy.subarray(0, regret.length), referenceMatch(regret, blocks))).toBeLessThan(1e-6);
		});
	}
});

interface GpuOutcome {
	adapter: string | null;
	spots: Record<string, { showdown: [number[], number[]]; strategy: number[] }>;
}

describe('WebGPU river kernels', () => {
	let gpu: GpuOutcome | null = null;
	// Anything but a missing browser fails these tests, not the file.
	let failure: unknown = null;

	beforeAll(async () => {
		const source = `
			import { createRiverGpu, requestGpu } from './src/gpu/river.ts';
			import { makeBlocks, makeReach, riverFixture } from './bench/gpu/fixture.ts';
			const SPOTS = ${JSON.stringify(SPOTS)};
			export default async function run() {
				const found = await requestGpu();
				if (!found) return { adapter: null, spots: {} };
				const spots = {};
				for (const [name, config] of Object.entries(SPOTS)) {
					const fixture = riverFixture(config);
					const kernels = await createRiverGpu(found.device, fixture.lists);
					const showdown = [];
					for (const me of [0, 1]) {
						showdown.push(Array.from(await kernels.showdown(me, makeReach(fixture.lists, 11 + me), fixture.scale)));
					}
					const decision = fixture.decisions[0];
					const { blocks, regret } = makeBlocks(fixture.lists, decision.player, decision.actions, 7);
					const strategy = Array.from(await kernels.regretMatch(regret, blocks));
					kernels.destroy();
					spots[name] = { showdown, strategy };
				}
				found.device.destroy();
				return { adapter: found.info.vendor + ' ' + found.info.architecture, spots };
			}
		`;
		try {
			// SwiftShader's WebGPU, which needs no GPU: correct, but slow.
			gpu = await runInBrowser<GpuOutcome>(source, 170_000, {
				launch: { args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'] },
			});
		} catch (error) {
			if (error instanceof NoBrowserError) console.warn(`Skipping GPU checks: ${error.message}`);
			else failure = error;
		}
		if (gpu && !gpu.adapter) console.warn('Skipping GPU checks: Chromium offers no WebGPU adapter');
	}, 180_000);

	for (const [name, config] of Object.entries(SPOTS)) {
		it(`match the definitions on the ${name} turn`, (context) => {
			if (failure) throw failure;
			if (!gpu?.adapter) {
				context.skip();
				return;
			}
			const fixture = riverFixture(config);
			const { lists } = fixture;
			const there = gpu.spots[name];
			for (const me of [0, 1] as const) {
				const reach = makeReach(lists, 11 + me);
				const want = referenceShowdown(lists, me, reach, fixture.scale);
				// The GPU returns the river entries only, from the first.
				const got = new Float64Array(lists.entries);
				got.set(there.showdown[me], lists.first);
				// Single-precision sums over a few hundred hands.
				expect(showdownError(lists, me, reach, fixture.scale, got, want)).toBeLessThan(1e-5);
			}
			const decision = fixture.decisions[0];
			const { blocks, regret } = makeBlocks(lists, decision.player, decision.actions, 7);
			expect(there.strategy.length).toBe(regret.length);
			expect(largest(there.strategy, referenceMatch(regret, blocks))).toBeLessThan(1e-6);
		});
	}
});

describe('the package bundles', () => {
	it('carry no GPU code', async () => {
		for (const entry of ['./src/index.ts', './src/threads.ts']) {
			const bundle = await bundleForBrowser(`export * from '${entry}'; export default async () => 0;`);
			expect(bundle).not.toMatch(/navigator\.gpu|createRiverGpu|RIVER_WASM/);
		}
	});
});
