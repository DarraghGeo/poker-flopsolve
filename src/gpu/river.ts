/**
 * River showdown and regret matching on the GPU: the WebGPU experiment (#39).
 *
 * Purpose: find out whether the river's data-parallel steps — showdown values
 * on every river board, and regret matching over every river block — run
 * faster as WebGPU compute, transfers included, than in the WebAssembly engine.
 * Kernels only: nothing in the package imports this, so the solver, its
 * results, its speed and its bundle are exactly what they were. See
 * `bin/bench-gpu.ts` for the measurement.
 *
 * Both kernels read the vectors the engine already lays out — `ActiveLists`,
 * one entry per hand per board, so a board's list is a contiguous slice.
 *
 * Showdown is not the engine's two strength sweeps, which are sequential.
 * Each hand instead sums, over every opponent hand it does not share a card
 * with, the opponent's reach signed by who wins: O(n²) per board where the
 * sweep is O(n), but every hand on every board at once, with the opponent's
 * hands staged through workgroup memory. A packed opponent list is summed
 * over each entry's members, the hands it stands for, exactly as the engine's
 * `showdownPacked` counts them. Arithmetic is f32 throughout (WGSL has no
 * f64), so values agree with the engine to float tolerance, not to the bit.
 */

import type { ActiveLists } from '../cfr.ts';
import type { Runouts } from '../runouts.ts';

/** Every river board's lists, as the kernels and the CPU twin read them. */
export interface RiverLists {
	/** River boards. */
	readonly boards: number;
	/** Entries in the whole active list: vectors are this long, indexed by entry. */
	readonly entries: number;
	/**
	 * The first river entry. The river is the last round, so its lists run
	 * from here to `entries`; only that range of a vector moves to the GPU.
	 */
	readonly first: number;
	/** Each board's list per player, at `board * 2 + player`: first entry, entries, whether packed. */
	readonly start: Int32Array;
	readonly count: Int32Array;
	readonly packed: Uint8Array;
	/** The longest list on any river board. */
	readonly maxCount: number;
	/** By entry, as `ActiveLists`. */
	readonly strength: Int32Array;
	readonly cardA: Uint8Array;
	readonly cardB: Uint8Array;
	readonly memberStart: Int32Array;
	readonly memberA: Uint8Array;
	readonly memberB: Uint8Array;
}

/** The river round's lists of a prepared spot. */
export function riverLists(active: ActiveLists, runouts: Runouts): RiverLists {
	const last = runouts.rounds - 1;
	const boards = runouts.counts[last];
	const start = new Int32Array(boards * 2);
	const count = new Int32Array(boards * 2);
	const packed = new Uint8Array(boards * 2);
	let maxCount = 0;
	for (let board = 0; board < boards; board++) {
		for (let player = 0; player < 2; player++) {
			const slot = (active.roundBase[last] + board) * 2 + player;
			start[board * 2 + player] = active.start[slot];
			count[board * 2 + player] = active.count[slot];
			packed[board * 2 + player] = active.packed[slot];
			maxCount = Math.max(maxCount, active.count[slot]);
		}
	}
	return {
		boards, entries: active.list.length, first: active.start[active.roundBase[last] * 2], start, count, packed, maxCount,
		strength: active.strength, cardA: active.cardA, cardB: active.cardB,
		memberStart: active.memberStart, memberA: active.memberA, memberB: active.memberB,
	};
}

// --- The parts of WebGPU used here, typed locally: the project builds without DOM typings. ---

interface GpuBuffer {
	readonly size: number;
	mapAsync(mode: number): Promise<void>;
	getMappedRange(): ArrayBuffer;
	unmap(): void;
	destroy(): void;
}
interface GpuComputePass {
	setPipeline(pipeline: unknown): void;
	setBindGroup(index: number, group: unknown): void;
	dispatchWorkgroups(x: number, y?: number, z?: number): void;
	end(): void;
}
interface GpuEncoder {
	beginComputePass(): GpuComputePass;
	copyBufferToBuffer(source: GpuBuffer, sourceOffset: number, target: GpuBuffer, targetOffset: number, size: number): void;
	finish(): unknown;
}
/** A WebGPU device, as far as this module uses one. */
export interface GpuDevice {
	createBuffer(descriptor: { size: number; usage: number; mappedAtCreation?: boolean }): GpuBuffer & { getMappedRange(): ArrayBuffer };
	createShaderModule(descriptor: { code: string }): unknown;
	createComputePipeline(descriptor: { layout: 'auto'; compute: { module: unknown; entryPoint: string } }): { getBindGroupLayout(index: number): unknown };
	createBindGroup(descriptor: { layout: unknown; entries: { binding: number; resource: { buffer: GpuBuffer } }[] }): unknown;
	createCommandEncoder(): GpuEncoder;
	readonly queue: {
		writeBuffer(buffer: GpuBuffer, offset: number, data: ArrayBufferView): void;
		submit(commands: unknown[]): void;
		onSubmittedWorkDone(): Promise<void>;
	};
	readonly limits: { maxStorageBufferBindingSize: number; maxComputeWorkgroupsPerDimension: number };
	pushErrorScope(filter: 'validation' | 'out-of-memory'): void;
	popErrorScope(): Promise<{ message: string } | null>;
	destroy(): void;
}

// The GPUBufferUsage and GPUMapMode bits, which are fixed by the spec.
const MAP_READ = 0x0001;
const COPY_SRC = 0x0004;
const COPY_DST = 0x0008;
const UNIFORM = 0x0040;
const STORAGE = 0x0080;

/** What the adapter is, for reports: a CPU emulation's timings mean nothing. */
export interface GpuInfo {
	vendor: string;
	architecture: string;
	description: string;
}

/**
 * A WebGPU device, or null where the platform has none — no `navigator.gpu`,
 * or no adapter, as in headless Chromium without WebGPU flags.
 */
export async function requestGpu(): Promise<{ device: GpuDevice; info: GpuInfo } | null> {
	const gpu = (globalThis as unknown as { navigator?: { gpu?: { requestAdapter(options?: object): Promise<unknown> } } }).navigator?.gpu;
	if (!gpu) return null;
	const adapter = (await gpu.requestAdapter({ powerPreference: 'high-performance' })) as {
		info?: Partial<GpuInfo>;
		limits: { maxStorageBufferBindingSize: number };
		requestDevice(options?: object): Promise<GpuDevice>;
	} | null;
	if (!adapter) return null;
	let device: GpuDevice;
	try {
		device = await adapter.requestDevice({
			requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize },
		});
	} catch {
		return null;
	}
	const info = adapter.info ?? {};
	return {
		device,
		info: { vendor: info.vendor ?? '', architecture: info.architecture ?? '', description: info.description ?? '' },
	};
}

const WORKGROUP = 64;

const SHOWDOWN_WGSL = /* wgsl */ `
struct Params { scale: f32, me: u32, first: u32, pad: u32 }

@group(0) @binding(0) var<uniform> params: Params;
// Per board and player: first entry, entries, first member, end of members.
@group(0) @binding(1) var<storage, read> lists: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read> strength: array<i32>;
// By entry: first card | second card << 8.
@group(0) @binding(3) var<storage, read> cards: array<u32>;
// By member: its cards as above, and the entry standing for it.
@group(0) @binding(4) var<storage, read> members: array<vec2<u32>>;
// From the first river entry, params.first.
@group(0) @binding(5) var<storage, read> reach: array<f32>;
@group(0) @binding(6) var<storage, read_write> values: array<f32>;

var<workgroup> tileStrength: array<i32, ${WORKGROUP}>;
var<workgroup> tileReach: array<f32, ${WORKGROUP}>;
var<workgroup> tileCards: array<u32, ${WORKGROUP}>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
	let board = group.y;
	let mine = lists[board * 2u + params.me];
	let theirs = lists[board * 2u + 1u - params.me];
	let i = group.x * ${WORKGROUP}u + lane;
	let live = i < mine.y;
	var level = 0;
	var a = 64u;
	var b = 64u;
	if (live) {
		level = strength[mine.x + i];
		let c = cards[mine.x + i];
		a = c & 0xffu;
		b = c >> 8u;
	}
	var total = 0.0;
	for (var tile = theirs.z; tile < theirs.w; tile += ${WORKGROUP}u) {
		let m = tile + lane;
		if (m < theirs.w) {
			let member = members[m];
			tileCards[lane] = member.x;
			tileStrength[lane] = strength[member.y];
			tileReach[lane] = reach[member.y - params.first];
		}
		workgroupBarrier();
		let n = min(${WORKGROUP}u, theirs.w - tile);
		for (var k = 0u; k < n; k++) {
			let c = tileCards[k];
			let ca = c & 0xffu;
			let cb = c >> 8u;
			if (ca != a && ca != b && cb != a && cb != b) {
				let s = tileStrength[k];
				let r = tileReach[k];
				total += select(0.0, r, s < level) - select(0.0, r, s > level);
			}
		}
		workgroupBarrier();
	}
	if (live) {
		values[mine.x + i - params.first] = params.scale * total;
	}
}
`;

const REGRET_WGSL = /* wgsl */ `
// Per block: its offset in floats, actions, hands.
@group(0) @binding(0) var<storage, read> blocks: array<vec4<u32>>;
@group(0) @binding(1) var<storage, read> regret: array<f32>;
@group(0) @binding(2) var<storage, read_write> strategy: array<f32>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
	let block = blocks[group.y];
	let i = group.x * ${WORKGROUP}u + lane;
	if (i >= block.z) {
		return;
	}
	var total = 0.0;
	for (var a = 0u; a < block.y; a++) {
		total += max(regret[block.x + a * block.z + i], 0.0);
	}
	let even = 1.0 / f32(block.y);
	for (var a = 0u; a < block.y; a++) {
		let at = block.x + a * block.z + i;
		strategy[at] = select(even, max(regret[at], 0.0) / total, total > 0.0);
	}
}
`;

/** The river kernels on one device, with the spot's lists uploaded once. */
export interface RiverGpu {
	/**
	 * Showdown values on every river board: upload the river part of the
	 * opponent's reach, run, read the river part back. The result holds the
	 * river entries, from `lists.first`: value of entry `e` at `e - first`.
	 * Only the traverser's lists in it mean anything.
	 *
	 * @param traverser whose values
	 * @param reach the opponent's reach, by entry
	 * @param scale chips times the round's runout weight over the chip scale
	 */
	showdown(traverser: 0 | 1, reach: Float32Array, scale: number): Promise<Float32Array>;
	/**
	 * Regret matching over a batch of blocks: upload, run, read back.
	 *
	 * @param regret f32 regrets
	 * @param blocks three i32 per block: offset in floats, actions, hands
	 */
	regretMatch(regret: Float32Array, blocks: Int32Array): Promise<Float32Array>;
	/** Milliseconds per showdown dispatch on the GPU alone: `reps` back to back, no transfers. */
	showdownKernelMs(reps: number): Promise<number>;
	/** Milliseconds per regret-matching dispatch alone, on the last batch given. */
	regretKernelMs(reps: number): Promise<number>;
	/** Release the buffers. */
	destroy(): void;
}

/**
 * Set up the kernels and upload the spot's lists.
 * @throws when the device rejects a shader, pipeline or buffer, which WebGPU
 *   would otherwise only report to the console while every result read zero
 */
export async function createRiverGpu(device: GpuDevice, lists: RiverLists): Promise<RiverGpu> {
	const maxRows = device.limits.maxComputeWorkgroupsPerDimension;
	if (lists.boards > maxRows) throw new Error(`${lists.boards} river boards is past this GPU's ${maxRows} workgroups per dimension`);
	device.pushErrorScope('out-of-memory');
	device.pushErrorScope('validation');
	let kernels: RiverGpu | null = null;
	let thrown: unknown = null;
	const owned: GpuBuffer[] = [];
	try {
		kernels = setUp(device, lists, owned);
	} catch (error) {
		thrown = error;
	}
	// Popped whatever happened, so the scopes never swallow later errors.
	const invalid = await device.popErrorScope();
	const exhausted = await device.popErrorScope();
	const error = invalid ?? exhausted;
	if (thrown || error) {
		if (kernels) kernels.destroy();
		else for (const buffer of owned) buffer.destroy();
		if (thrown) throw thrown;
		throw new Error(`WebGPU river kernels: ${error!.message}`);
	}
	return kernels!;
}

/** The kernels; every static buffer goes into `owned` as it is made, so a failure part way can free them. */
function setUp(device: GpuDevice, lists: RiverLists, owned: GpuBuffer[]): RiverGpu {
	const upload = (data: ArrayBufferView, usage = STORAGE): GpuBuffer => {
		const buffer = device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: usage | COPY_DST });
		device.queue.writeBuffer(buffer, 0, data);
		owned.push(buffer);
		return buffer;
	};
	const empty = (bytes: number, usage: number): GpuBuffer => {
		const buffer = device.createBuffer({ size: Math.max(16, Math.ceil(bytes / 4) * 4), usage });
		owned.push(buffer);
		return buffer;
	};

	// Static: the lists, cards, members.
	const listData = new Uint32Array(lists.boards * 2 * 4);
	for (let k = 0; k < lists.boards * 2; k++) {
		const from = lists.start[k];
		const to = from + lists.count[k];
		listData.set([from, lists.count[k], lists.memberStart[from], lists.memberStart[to]], k * 4);
	}
	const cards = new Uint32Array(lists.entries);
	for (let e = 0; e < lists.entries; e++) cards[e] = lists.cardA[e] | (lists.cardB[e] << 8);
	const memberCount = lists.memberStart[lists.entries];
	const members = new Uint32Array(memberCount * 2);
	for (let e = 0; e < lists.entries; e++) {
		for (let m = lists.memberStart[e]; m < lists.memberStart[e + 1]; m++) {
			members[m * 2] = lists.memberA[m] | (lists.memberB[m] << 8);
			members[m * 2 + 1] = e;
		}
	}
	const vectorBytes = (lists.entries - lists.first) * 4;
	const listBuffer = upload(listData);
	const strengthBuffer = upload(lists.strength);
	const cardBuffer = upload(cards);
	const memberBuffer = upload(members);
	const params = empty(16, UNIFORM | COPY_DST);
	const reachBuffer = empty(vectorBytes, STORAGE | COPY_DST);
	const valueBuffer = empty(vectorBytes, STORAGE | COPY_SRC);
	const valueRead = empty(vectorBytes, MAP_READ | COPY_DST);

	const showdownPipeline = device.createComputePipeline({
		layout: 'auto',
		compute: { module: device.createShaderModule({ code: SHOWDOWN_WGSL }), entryPoint: 'main' },
	});
	const showdownGroup = device.createBindGroup({
		layout: showdownPipeline.getBindGroupLayout(0),
		entries: [params, listBuffer, strengthBuffer, cardBuffer, memberBuffer, reachBuffer, valueBuffer].map((buffer, binding) => ({
			binding,
			resource: { buffer },
		})),
	});
	const regretPipeline = device.createComputePipeline({
		layout: 'auto',
		compute: { module: device.createShaderModule({ code: REGRET_WGSL }), entryPoint: 'main' },
	});
	const columns = Math.ceil(Math.max(1, lists.maxCount) / WORKGROUP);
	const maxRows = device.limits.maxComputeWorkgroupsPerDimension;

	const read = async (source: GpuBuffer, target: GpuBuffer, bytes: number, encoder: GpuEncoder): Promise<Float32Array> => {
		encoder.copyBufferToBuffer(source, 0, target, 0, bytes);
		device.queue.submit([encoder.finish()]);
		await target.mapAsync(1);
		const out = new Float32Array(bytes / 4);
		out.set(new Float32Array(target.getMappedRange(), 0, bytes / 4));
		target.unmap();
		return out;
	};

	const setParams = (traverser: 0 | 1, scale: number): void => {
		const data = new ArrayBuffer(16);
		new Float32Array(data, 0, 1)[0] = scale;
		new Uint32Array(data, 4, 2).set([traverser, lists.first]);
		device.queue.writeBuffer(params, 0, new Uint8Array(data));
	};
	const showdownPass = (encoder: GpuEncoder, reps: number): void => {
		const pass = encoder.beginComputePass();
		pass.setPipeline(showdownPipeline);
		pass.setBindGroup(0, showdownGroup);
		for (let r = 0; r < reps; r++) pass.dispatchWorkgroups(columns, lists.boards);
		pass.end();
	};

	// Regret batches change size; their buffers grow as needed.
	let regretBatch: { blocks: GpuBuffer; regret: GpuBuffer; strategy: GpuBuffer; read: GpuBuffer; group: unknown; bytes: number; rows: number; columns: number } | null = null;
	const destroyBatch = (): void => {
		if (regretBatch) for (const buffer of [regretBatch.blocks, regretBatch.regret, regretBatch.strategy, regretBatch.read]) buffer.destroy();
		regretBatch = null;
	};
	const regretBuffers = (floats: number, blockCount: number) => {
		const bytes = floats * 4;
		if (regretBatch && regretBatch.regret.size >= bytes && regretBatch.blocks.size >= blockCount * 16) return regretBatch;
		destroyBatch();
		const blocks = device.createBuffer({ size: Math.max(16, blockCount * 16), usage: STORAGE | COPY_DST });
		const regret = device.createBuffer({ size: Math.max(16, bytes), usage: STORAGE | COPY_DST });
		const strategy = device.createBuffer({ size: Math.max(16, bytes), usage: STORAGE | COPY_SRC });
		const target = device.createBuffer({ size: Math.max(16, bytes), usage: MAP_READ | COPY_DST });
		const group = device.createBindGroup({
			layout: regretPipeline.getBindGroupLayout(0),
			entries: [blocks, regret, strategy].map((buffer, binding) => ({ binding, resource: { buffer } })),
		});
		regretBatch = { blocks, regret, strategy, read: target, group, bytes, rows: 0, columns: 0 };
		return regretBatch;
	};
	const regretPass = (encoder: GpuEncoder, reps: number): void => {
		const batch = regretBatch!;
		const pass = encoder.beginComputePass();
		pass.setPipeline(regretPipeline);
		pass.setBindGroup(0, batch.group);
		for (let r = 0; r < reps; r++) pass.dispatchWorkgroups(batch.columns, batch.rows);
		pass.end();
	};
	const submit = async (pass: (encoder: GpuEncoder, reps: number) => void, reps: number): Promise<number> => {
		const encoder = device.createCommandEncoder();
		pass(encoder, reps);
		const started = performance.now();
		device.queue.submit([encoder.finish()]);
		await device.queue.onSubmittedWorkDone();
		return performance.now() - started;
	};
	const timed = async (pass: (encoder: GpuEncoder, reps: number) => void, reps: number): Promise<number> => {
		if (!(reps >= 1)) throw new Error('reps must be at least 1');
		await submit(pass, 1); // warm-up
		return (await submit(pass, Math.floor(reps))) / Math.floor(reps);
	};

	return {
		async showdown(traverser, reach, scale) {
			setParams(traverser, scale);
			device.queue.writeBuffer(reachBuffer, 0, reach.subarray(lists.first, lists.entries));
			const encoder = device.createCommandEncoder();
			showdownPass(encoder, 1);
			return read(valueBuffer, valueRead, vectorBytes, encoder);
		},
		async regretMatch(regret, blocks) {
			const count = blocks.length / 3;
			if (count > maxRows) throw new Error(`${count} blocks is past this GPU's ${maxRows} workgroups per dimension`);
			const batch = regretBuffers(regret.length, count);
			const descriptors = new Uint32Array(count * 4);
			let widest = 0;
			for (let k = 0; k < count; k++) {
				descriptors.set([blocks[k * 3], blocks[k * 3 + 1], blocks[k * 3 + 2]], k * 4);
				widest = Math.max(widest, blocks[k * 3 + 2]);
			}
			batch.rows = count;
			batch.columns = Math.ceil(Math.max(1, widest) / WORKGROUP);
			batch.bytes = regret.byteLength;
			device.queue.writeBuffer(batch.blocks, 0, descriptors);
			device.queue.writeBuffer(batch.regret, 0, regret);
			const encoder = device.createCommandEncoder();
			regretPass(encoder, 1);
			return read(batch.strategy, batch.read, batch.bytes, encoder);
		},
		showdownKernelMs: (reps) => timed(showdownPass, reps),
		regretKernelMs: (reps) => {
			if (!regretBatch) throw new Error('regretKernelMs needs a batch: call regretMatch first');
			return timed(regretPass, reps);
		},
		destroy() {
			for (const buffer of owned) buffer.destroy();
			destroyBatch();
		},
	};
}
