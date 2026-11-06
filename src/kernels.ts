/**
 * The WebAssembly SIMD kernels, loaded.
 *
 * Purpose: give one thread its own instance of the kernels in
 * `assembly/kernels.ts`, or say there is none, so the caller falls back to
 * JavaScript.
 *
 * Each thread gets a private memory. The solver's accumulators stay where
 * they are — ordinary or shared typed arrays — and a block is copied in
 * before a kernel runs on it, which is a native memcpy (converting from f32
 * or i16 storage on the way) and costs far less than the kernel saves. That
 * keeps worker threads exactly as they were: nothing about sharing changes.
 */

import { KERNELS_WASM } from './wasm/kernels.ts';

/** One thread's kernels and the memory they work in. */
export interface Kernels {
	/**
	 * Regret matching over one block, `actions` rows of `count` slots. The
	 * block must already be in `input`; the strategy lands in `out`.
	 */
	regretMatch(out: Float64Array, actions: number, count: number): void;
	/**
	 * The average strategy over one block: its strategy sums in `input`, and
	 * its regrets in `second` when `hasRegret`, for hands whose sums are zero.
	 */
	averageMatch(out: Float64Array, actions: number, count: number, hasRegret: boolean): void;
	/** Where a block is copied before a kernel runs on it. */
	readonly input: Float64Array;
	/** A second block, for kernels that read two. */
	readonly second: Float64Array;
	/**
	 * A strategy buffer in kernel memory, `actions * count` doubles: what
	 * `regretMatch` writes into. One per traversal depth.
	 */
	strategy(depth: number): Float64Array;
}

/** The parts of the WebAssembly API used here, typed locally: the project builds without DOM typings. */
interface WasmApi {
	validate(bytes: Uint8Array): boolean;
	Module: new (bytes: Uint8Array) => object;
	Instance: new (module: object, imports: object) => { exports: Record<string, unknown> };
	Memory: new (descriptor: { initial: number }) => { buffer: ArrayBuffer };
}

const wasm = (globalThis as unknown as { WebAssembly?: WasmApi }).WebAssembly;

let module: object | null | undefined;

/** The compiled module, or null where WebAssembly SIMD is unavailable. */
function compiled(): object | null {
	if (module !== undefined) return module;
	module = null;
	try {
		if (!wasm) return null;
		const bytes = Uint8Array.from(atob(KERNELS_WASM), (c) => c.charCodeAt(0));
		// Validation fails exactly where SIMD is unsupported.
		if (!wasm.validate(bytes)) return null;
		module = new wasm.Module(bytes);
	} catch {
		module = null;
	}
	return module;
}

/**
 * Instantiate the kernels for one thread.
 *
 * @param depths traversal depths, each needing its own strategy buffer
 * @param width doubles per buffer: actions times the widest range
 * @returns null where WebAssembly SIMD is unavailable
 */
export function loadKernels(depths: number, width: number): Kernels | null {
	const compiledModule = compiled();
	if (!compiledModule || !wasm) return null;
	// Layout, in doubles: two inputs, totals (twice over), then one strategy
	// buffer per depth.
	const second = width;
	const totals = 2 * width;
	const first = 4 * width;
	const bytes = (first + depths * width) * 8;
	const memory = new wasm.Memory({ initial: Math.ceil(bytes / 65536) + 1 });
	const instance = new wasm.Instance(compiledModule, { env: { memory } });
	const regretMatch = instance.exports.regretMatch as (
		regret: number,
		out: number,
		total: number,
		actions: number,
		count: number,
	) => void;
	const averageMatch = instance.exports.averageMatch as (
		sums: number,
		regret: number,
		out: number,
		total: number,
		actions: number,
		count: number,
		hasRegret: number,
	) => void;
	const heap = new Float64Array(memory.buffer);
	const input = heap.subarray(0, width);
	const secondInput = heap.subarray(second, second + width);
	const buffers = Array.from({ length: depths }, (_, depth) =>
		heap.subarray(first + depth * width, first + (depth + 1) * width),
	);
	return {
		input,
		second: secondInput,
		strategy: (depth) => buffers[depth],
		regretMatch(out, actions, count) {
			regretMatch(0, out.byteOffset, totals * 8, actions, count);
		},
		averageMatch(out, actions, count, hasRegret) {
			averageMatch(0, second * 8, out.byteOffset, totals * 8, actions, count, hasRegret ? 1 : 0);
		},
	};
}

/** Whether this platform runs the WebAssembly SIMD kernels; false means JavaScript throughout. */
export function simdAvailable(): boolean {
	return compiled() !== null;
}
