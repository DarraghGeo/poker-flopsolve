/**
 * The kernel experiment of issue #39, run where WebGPU is: in a browser.
 *
 * Purpose: on one spot, time the engine's river showdown and regret matching
 * (WebAssembly SIMD) against the WebGPU kernels over the batch one training
 * iteration hands them, and check the two agree. It also times a whole
 * iteration of the real engine, so the bench can say what share of it the
 * river kernels are, and so what offloading them could buy at best.
 *
 * Bench-only. bin/bench-gpu.ts bundles this into a page;
 * test/gpu-showdown.browser.test.ts calls it with `verifyOnly`.
 */

import { createRun, defineSpot } from '../../src/index.ts';
import type { SpotConfig } from '../../src/index.ts';
import { cpuBatch } from './cpu.ts';
import type { Batch, Gpu } from './host.ts';
import { matchBatch, openGpu, showdownBatch } from './host.ts';
import { buildShowdownTables, listMatchBlocks, listShowdownJobs, packBlocks, packJobs } from './layout.ts';

export interface ExperimentOptions {
	readonly config: SpotConfig;
	/** The compiled assembly/bench-showdown.ts, base64. */
	readonly wasm: string;
	/** Timed repetitions of each batch. */
	readonly reps: number;
	/** Iterations of the real engine to time. */
	readonly iterations: number;
	/** Check agreement only: one run of each, no timing. */
	readonly verifyOnly?: boolean;
}

/** Milliseconds for one training iteration's worth: both traversers. */
export interface KernelTimes {
	readonly cpu: number;
	readonly gpuKernel: number;
	readonly gpuRoundTrip: number;
}

export interface ExperimentResult {
	readonly adapter: string | null;
	readonly software: boolean;
	readonly jobs: number;
	/** Of them, jobs against a packed opponent list. */
	readonly packedJobs: number;
	readonly hands: number;
	readonly blocks: number;
	readonly slots: number;
	/** Bytes uploaded and read back per iteration by the showdown round trips. */
	readonly showdownBytes: number;
	/** Largest showdown disagreement, over the job's |scale| × opponent reach. */
	readonly showdownError: number;
	/** Largest regret-matching disagreement, in probability. */
	readonly matchError: number;
	readonly showdown: KernelTimes | null;
	readonly match: KernelTimes | null;
	/** One training iteration of the real engine, single-threaded. */
	readonly iterationMs: number;
}

function random(seed: number): () => number {
	let s = seed | 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
}

async function median(reps: number, run: () => Promise<void> | void): Promise<number> {
	await run(); // warm-up
	const times: number[] = [];
	for (let i = 0; i < reps; i++) {
		const started = performance.now();
		await run();
		times.push(performance.now() - started);
	}
	times.sort((a, b) => a - b);
	return times[times.length >> 1];
}

export default async function experiment(options: ExperimentOptions): Promise<ExperimentResult> {
	const { config, reps } = options;
	const bytes = Uint8Array.from(atob(options.wasm), (c) => c.charCodeAt(0));
	const run = createRun(defineSpot(config), { workers: 1 });
	const ctx = run.solver.ctx;
	const tables = buildShowdownTables(ctx);
	const blockList = listMatchBlocks(ctx);
	const blocks = packBlocks(blockList);
	const regretLength = ctx.layout.totalSlots;
	const maxActions = ctx.layout.maxActions;
	const next = random(0x2545f491);

	const gpu: Gpu | null = await openGpu();
	let jobs = 0;
	let packedJobs = 0;
	let hands = 0;
	let showdownBytes = 0;
	let showdownError = 0;
	const showdown = { cpu: 0, gpuKernel: 0, gpuRoundTrip: 0 };

	for (const traverser of [0, 1] as const) {
		const list = listShowdownJobs(ctx, traverser);
		const { records, reachLength, outLength } = packJobs(list);
		jobs += list.length;
		packedJobs += list.filter((job) => job.packed).length;
		hands += outLength;
		showdownBytes += (reachLength + outLength) * 4;
		const cpu = cpuBatch(bytes, ctx.active, records, reachLength, outLength, blocks, 0, tables.maxList, maxActions);
		for (let i = 0; i < reachLength; i++) {
			const u = next();
			cpu.reach[i] = u < 0.33 ? 0 : u;
		}
		const reach = cpu.reach.slice();
		cpu.runShowdowns();
		if (!options.verifyOnly) showdown.cpu += await median(reps, () => cpu.runShowdowns());
		if (!gpu) continue;

		const batch: Batch = await showdownBatch(gpu, tables, records, reachLength, outLength);
		const values = await batch.roundTrip(reach);
		let reachAt = 0;
		let outAt = 0;
		for (const job of list) {
			let mass = 0;
			for (let j = 0; j < job.oppCount; j++) mass += reach[reachAt + j] * tables.members[job.oppFrom + j];
			const unit = Math.abs(job.scale) * mass || 1;
			for (let i = 0; i < job.myCount; i++) {
				const error = Math.abs(values[outAt + i] - cpu.out[outAt + i]) / unit;
				if (!(error <= showdownError)) showdownError = Number.isNaN(error) ? Infinity : error;
			}
			reachAt += job.oppCount;
			outAt += job.myCount;
		}
		if (!options.verifyOnly) {
			showdown.gpuKernel += await median(reps, () => batch.kernel());
			showdown.gpuRoundTrip += await median(reps, async () => void (await batch.roundTrip(reach)));
		}
		batch.destroy();
	}

	// Regret matching: every river block, once per traversal.
	const cpu = cpuBatch(bytes, ctx.active, new Uint32Array(0), 0, 0, blocks, regretLength, tables.maxList, maxActions);
	for (let i = 0; i < regretLength; i++) cpu.regret[i] = next() < 0.2 ? 0 : next() * 2 - 1;
	const regret = cpu.regret.slice();
	let match: KernelTimes | null = null;
	let matchError = 0;
	const cpuMatch = options.verifyOnly ? 0 : 2 * (await median(reps, () => cpu.runMatches()));
	if (gpu) {
		const batch = await matchBatch(gpu, regret, blocks);
		const strategy = await batch.roundTrip();
		for (let b = 0; b < blockList.length; b += 13) {
			const { offset, actions, count } = blockList[b];
			for (let i = 0; i < count; i++) {
				let total = 0;
				for (let a = 0; a < actions; a++) total += Math.max(regret[offset + a * count + i], 0);
				for (let a = 0; a < actions; a++) {
					const at = offset + a * count + i;
					const want = total > 0 ? Math.max(regret[at], 0) / total : 1 / actions;
					const error = Math.abs(strategy[at] - want);
					if (!(error <= matchError)) matchError = Number.isNaN(error) ? Infinity : error;
				}
			}
		}
		if (!options.verifyOnly) {
			match = {
				cpu: cpuMatch,
				gpuKernel: 2 * (await median(reps, () => batch.kernel())),
				gpuRoundTrip: 2 * (await median(reps, async () => void (await batch.roundTrip(regret)))),
			};
		}
		batch.destroy();
	} else if (!options.verifyOnly) {
		match = { cpu: cpuMatch, gpuKernel: NaN, gpuRoundTrip: NaN };
	}

	let iterationMs = NaN;
	if (!options.verifyOnly) {
		run.step(2);
		const started = performance.now();
		run.step(options.iterations);
		iterationMs = (performance.now() - started) / options.iterations;
	}
	run.close();
	gpu?.device.destroy();

	return {
		adapter: gpu ? gpu.adapter : null,
		software: gpu ? gpu.software : false,
		jobs, packedJobs, hands,
		blocks: blockList.length * 2,
		slots: blockList.reduce((sum, block) => sum + block.actions * block.count, 0),
		showdownBytes, showdownError, matchError,
		showdown: options.verifyOnly ? null : gpu ? showdown : { ...showdown, gpuKernel: NaN, gpuRoundTrip: NaN },
		match,
		iterationMs,
	};
}
