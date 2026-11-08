/**
 * The CPU side of the comparison: assembly/bench-showdown.ts, loaded.
 *
 * Purpose: lay a batch out in one WebAssembly memory the way the engine lays
 * out its lists, and run the engine's own showdown and regret-matching code
 * over it. Bench-only; the binary comes from `compileBenchWasm`.
 */

import type { ActiveLists } from '../../src/cfr.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** The CPU kernels over one batch. */
export interface CpuBatch {
	/** Reach in, as the GPU gets it: one run per job. */
	readonly reach: Float32Array;
	/** Values out, one run per job. */
	readonly out: Float32Array;
	runShowdowns(): void;
	/** Regrets in; `runMatches` matches every block. */
	readonly regret: Float32Array;
	runMatches(): void;
}

/**
 * Instantiate the bench module over a batch.
 * @param bytes the compiled assembly/bench-showdown.ts
 */
export function cpuBatch(
	bytes: Uint8Array,
	active: ActiveLists,
	jobs: Uint32Array,
	reachLength: number,
	outLength: number,
	blocks: Uint32Array,
	regretLength: number,
	maxList: number,
	maxActions: number,
): CpuBatch {
	const wasm = (globalThis as Any).WebAssembly;
	const pieces: { data: ArrayBufferView | null; bytes: number }[] = [];
	const add = (data: ArrayBufferView | null, bytes = data ? data.byteLength : 0): number => {
		pieces.push({ data, bytes: Math.ceil(Math.max(bytes, 16) / 16) * 16 });
		return pieces.length - 1;
	};
	const slots = {
		cardA: add(active.cardA), cardB: add(active.cardB), strength: add(active.strength),
		memberStart: add(active.memberStart), memberA: add(active.memberA), memberB: add(active.memberB),
		sums: add(null, (52 + maxList) * 8), jobs: add(jobs), blocks: add(blocks),
		reach: add(null, reachLength * 4), out: add(null, outLength * 4),
		regret: add(null, regretLength * 4), scratch: add(null, (maxActions + 1) * maxList * 4),
	};
	const offsets: number[] = [];
	let total = 64;
	for (const piece of pieces) {
		offsets.push(total);
		total += piece.bytes;
	}
	const memory = new wasm.Memory({ initial: Math.ceil(total / 65536) + 1 });
	const heap = new Uint8Array(memory.buffer);
	pieces.forEach((piece, i) => {
		if (piece.data) heap.set(new Uint8Array(piece.data.buffer, piece.data.byteOffset, piece.data.byteLength), offsets[i]);
	});
	const instance = new wasm.Instance(new wasm.Module(bytes), { env: { memory, abort: () => { throw new Error('abort'); } } });
	const exports = instance.exports;
	exports.setup(
		offsets[slots.cardA], offsets[slots.cardB], offsets[slots.strength],
		offsets[slots.memberStart], offsets[slots.memberA], offsets[slots.memberB], offsets[slots.sums],
	);
	const jobCount = jobs.length / 8;
	const blockCount = blocks.length / 4;
	return {
		reach: new Float32Array(memory.buffer, offsets[slots.reach], reachLength),
		out: new Float32Array(memory.buffer, offsets[slots.out], outLength),
		regret: new Float32Array(memory.buffer, offsets[slots.regret], regretLength),
		runShowdowns: () => exports.runShowdowns(offsets[slots.jobs], jobCount, offsets[slots.reach], offsets[slots.out]),
		runMatches: () => exports.runMatches(offsets[slots.blocks], blockCount, offsets[slots.regret], offsets[slots.scratch]),
	};
}
