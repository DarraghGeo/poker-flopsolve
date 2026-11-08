/**
 * The WebGPU side: buffers, pipelines and timed dispatches.
 *
 * Purpose: run the kernels in wgsl.ts on a batch, and say how long it took.
 * The time is measured two ways. "Kernel" is the dispatch alone, with its
 * data already on the GPU. "Round trip" also covers uploading the batch's
 * reach and reading its values back (`mapAsync`), which is what a CPU solver
 * would pay to hand the work over. Bench-only.
 *
 * The project builds without DOM typings, so the WebGPU API is typed loosely
 * here.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

import { MAX_CARD_LIST, MAX_LIST } from './layout.ts';
import type { ShowdownTables } from './layout.ts';
import { GRID_ROW, MATCH_WGSL, SHOWDOWN_WGSL } from './wgsl.ts';

// WebGPU constants, inlined: GPUBufferUsage and GPUMapMode.
const MAP_READ = 0x0001;
const COPY_SRC = 0x0004;
const COPY_DST = 0x0008;
const STORAGE = 0x0080;
const MODE_READ = 0x0001;

/** An open device and what it is. */
export interface Gpu {
	readonly device: Any;
	/** Vendor and architecture, e.g. "google / swiftshader". */
	readonly adapter: string;
	/** Whether the adapter is a software rasteriser, whose timings mean nothing. */
	readonly software: boolean;
}

/** Open a device with the adapter's largest buffer limits, or null where there is none. */
export async function openGpu(): Promise<Gpu | null> {
	const gpu = (globalThis as Any).navigator?.gpu;
	if (!gpu) return null;
	const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
	if (!adapter) return null;
	const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
	const name = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ') || 'unknown';
	const device = await adapter.requestDevice({
		requiredLimits: {
			maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
			maxBufferSize: adapter.limits.maxBufferSize,
			maxStorageBuffersPerShaderStage: Math.min(10, adapter.limits.maxStorageBuffersPerShaderStage),
		},
	});
	const software = /swiftshader|llvmpipe|software|microsoft basic/i.test(name) || adapter.isFallbackAdapter === true;
	return { device, adapter: name, software };
}

function storage(device: Any, data: ArrayBufferView | number, extra = 0): Any {
	const bytes = typeof data === 'number' ? data : data.byteLength;
	const buffer = device.createBuffer({ size: Math.max(16, Math.ceil(bytes / 4) * 4), usage: STORAGE | COPY_DST | extra });
	if (typeof data !== 'number') device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
	return buffer;
}

function grid(count: number): [number, number] {
	return [Math.min(count, GRID_ROW), Math.ceil(count / GRID_ROW)];
}

/** A compiled kernel over one batch, run on demand. */
export interface Batch {
	/** Dispatch with the data already on the GPU; resolves when the GPU is done. */
	kernel(): Promise<void>;
	/** Upload `input` (if given), dispatch, and read the results back. */
	roundTrip(input?: Float32Array): Promise<Float32Array>;
	destroy(): void;
}

async function compile(device: Any, code: string, entryPoint: string): Promise<Any> {
	const module = device.createShaderModule({ code });
	const info = module.getCompilationInfo ? await module.getCompilationInfo() : { messages: [] };
	const errors = info.messages.filter((m: Any) => m.type === 'error');
	if (errors.length > 0) {
		throw new Error(`WGSL: ${errors.map((m: Any) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
	}
	return device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } });
}

function makeBatch(device: Any, pipeline: Any, bindings: Any[], inputBuffer: Any | null, outputBuffer: Any, outputLength: number, count: number): Batch {
	const bindGroup = device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: bindings.map((buffer, binding) => ({ binding, resource: { buffer } })),
	});
	const readback = device.createBuffer({ size: outputBuffer.size, usage: MAP_READ | COPY_DST });
	const [x, y] = grid(count);
	const encode = (copy: boolean): Any => {
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginComputePass();
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bindGroup);
		pass.dispatchWorkgroups(x, y);
		pass.end();
		if (copy) encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, outputBuffer.size);
		return encoder.finish();
	};
	return {
		async kernel() {
			device.queue.submit([encode(false)]);
			await device.queue.onSubmittedWorkDone();
		},
		async roundTrip(input) {
			if (input && inputBuffer) device.queue.writeBuffer(inputBuffer, 0, input.buffer, input.byteOffset, input.byteLength);
			device.queue.submit([encode(true)]);
			await readback.mapAsync(MODE_READ);
			const out = new Float32Array(readback.getMappedRange().slice(0, outputLength * 4));
			readback.unmap();
			return out;
		},
		destroy() {
			readback.destroy();
			for (const buffer of bindings) buffer.destroy();
		},
	};
}

/**
 * The showdown kernel over one batch of jobs (`packJobs`). The tables are
 * uploaded once; each round trip uploads the batch's reach.
 */
export async function showdownBatch(
	gpu: Gpu,
	tables: ShowdownTables,
	records: Uint32Array,
	reachLength: number,
	outLength: number,
): Promise<Batch> {
	if (tables.maxList > MAX_LIST || tables.maxCardList > MAX_CARD_LIST) {
		throw new Error(
			`a list of ${tables.maxList} hands (${tables.maxCardList} card positions) is past the kernel's ` +
				`${MAX_LIST} (${MAX_CARD_LIST}); raise MAX_LIST and MAX_CARD_LIST in bench/gpu/layout.ts`,
		);
	}
	const { device } = gpu;
	const pipeline = await compile(device, SHOWDOWN_WGSL, 'showdown');
	const reach = storage(device, reachLength * 4);
	const values = storage(device, outLength * 4, COPY_SRC);
	const bindings = [
		storage(device, tables.strength), storage(device, tables.cards), storage(device, tables.members),
		storage(device, tables.cardStart), storage(device, tables.cardPos), storage(device, records), reach, values,
	];
	return makeBatch(device, pipeline, bindings, reach, values, outLength, records.length / 8);
}

/**
 * The regret-matching kernel over every block (`packBlocks`) of `regret`.
 * Each round trip uploads the regrets and reads every strategy back.
 */
export async function matchBatch(gpu: Gpu, regret: Float32Array, records: Uint32Array): Promise<Batch> {
	const { device } = gpu;
	const pipeline = await compile(device, MATCH_WGSL, 'matchRegret');
	const regretBuffer = storage(device, regret);
	const strategy = storage(device, regret.length * 4, COPY_SRC);
	const bindings = [regretBuffer, storage(device, records), strategy];
	return makeBatch(device, pipeline, bindings, regretBuffer, strategy, regret.length, records.length / 4);
}
