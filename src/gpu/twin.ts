/**
 * The engine's river kernels, batched over boards, on the CPU: the side the
 * GPU kernels of `./river.ts` have to beat (#39).
 *
 * Purpose: run `assembly/river.ts` — the WebAssembly engine's own showdown and
 * regret-matching code, looped over every river board — on the same lists the
 * GPU reads. Like the engine, it works on data already in its memory, so its
 * timings carry no transfer. Nothing in the package imports this.
 */

import { RIVER_WASM } from '../wasm/river.ts';
import type { RiverLists } from './river.ts';

/** The parts of the WebAssembly API used here, typed locally: the project builds without DOM typings. */
interface WasmApi {
	Module: new (bytes: Uint8Array) => object;
	Instance: new (module: object, imports: object) => { exports: Record<string, unknown> };
	Memory: new (descriptor: { initial: number }) => { buffer: ArrayBuffer };
}

interface RiverExports {
	init(strength: number, a: number, b: number, starts: number, membersA: number, membersB: number, scratch: number): void;
	showdownBoards(reach: number, out: number, boards: number, count: number, scale: number): void;
	matchRegretBlocks(regret: number, out: number, blocks: number, count: number, total: number): void;
}

/** The river kernels in WebAssembly over one spot's lists. */
export interface RiverCpu {
	/** The opponent's reach by entry: write it here before `showdown`. */
	readonly reach: Float32Array;
	/** Values by entry, where `showdown` writes the traverser's lists. */
	readonly values: Float32Array;
	/** Showdown values on every river board, from `reach` into `values`. */
	showdown(traverser: 0 | 1, scale: number): void;
	/** Regrets for `regretMatch`, at most the capacity given. */
	readonly regret: Float32Array;
	/** Strategies at the regrets' offsets. */
	readonly strategy: Float32Array;
	/**
	 * Set the blocks `regretMatch` runs over: three i32 per block, offset in
	 * floats, actions, hands.
	 */
	setBlocks(blocks: Int32Array): void;
	/** Regret matching over the blocks set, from `regret` into `strategy`. */
	regretMatch(): void;
}

/**
 * Lay the lists out in a fresh memory.
 *
 * @param regretFloats capacity for regret batches, in floats
 * @param maxBlocks capacity for blocks per batch
 */
export function createRiverCpu(lists: RiverLists, regretFloats: number, maxBlocks: number): RiverCpu {
	const wasm = (globalThis as unknown as { WebAssembly?: WasmApi }).WebAssembly;
	if (!wasm) throw new Error('WebAssembly is unavailable');
	const members = lists.memberStart[lists.entries];
	let total = 64;
	const take = (bytes: number): number => {
		const at = total;
		total += Math.ceil(Math.max(bytes, 4) / 16) * 16;
		return at;
	};
	const at = {
		strength: take(lists.entries * 4),
		cardA: take(lists.entries),
		cardB: take(lists.entries),
		memberStart: take((lists.entries + 1) * 4),
		memberA: take(members),
		memberB: take(members),
		scratch: take(52 * 8 + lists.maxCount * 8),
		boards: [take(lists.boards * 20), take(lists.boards * 20)],
		reach: take(lists.entries * 4),
		values: take(lists.entries * 4),
		regret: take(regretFloats * 4),
		strategy: take(regretFloats * 4),
		blocks: take(maxBlocks * 12),
		total: take(lists.maxCount * 4 + 16),
	};
	const memory = new wasm.Memory({ initial: Math.ceil(total / 65536) + 1 });
	const bytes = new Uint8Array(memory.buffer);
	const put = (data: ArrayBufferView, offset: number): void =>
		bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
	put(lists.strength, at.strength);
	put(lists.cardA, at.cardA);
	put(lists.cardB, at.cardB);
	put(lists.memberStart, at.memberStart);
	put(lists.memberA, at.memberA);
	put(lists.memberB, at.memberB);
	for (const me of [0, 1] as const) {
		const boards = new Int32Array(memory.buffer, at.boards[me], lists.boards * 5);
		for (let board = 0; board < lists.boards; board++) {
			const mine = board * 2 + me;
			const theirs = board * 2 + 1 - me;
			boards.set([lists.start[mine], lists.count[mine], lists.start[theirs], lists.count[theirs], lists.packed[theirs]], board * 5);
		}
	}
	const module = new wasm.Module(Uint8Array.from(atob(RIVER_WASM), (c) => c.charCodeAt(0)));
	const exports = new wasm.Instance(module, { env: { memory, abort: () => { throw new Error('river abort'); } } })
		.exports as unknown as RiverExports;
	exports.init(at.strength, at.cardA, at.cardB, at.memberStart, at.memberA, at.memberB, at.scratch);

	let blockCount = 0;
	return {
		reach: new Float32Array(memory.buffer, at.reach, lists.entries),
		values: new Float32Array(memory.buffer, at.values, lists.entries),
		regret: new Float32Array(memory.buffer, at.regret, regretFloats),
		strategy: new Float32Array(memory.buffer, at.strategy, regretFloats),
		showdown(traverser, scale) {
			exports.showdownBoards(at.reach, at.values, at.boards[traverser], lists.boards, scale);
		},
		setBlocks(blocks) {
			if (blocks.length / 3 > maxBlocks) throw new Error(`${blocks.length / 3} blocks is past the capacity of ${maxBlocks}`);
			for (let k = 0; k < blocks.length; k += 3) {
				if (blocks[k] + blocks[k + 1] * blocks[k + 2] > regretFloats) throw new Error('a block runs past the regret capacity');
				if (blocks[k + 2] > lists.maxCount) throw new Error('a block is wider than any river list');
			}
			new Int32Array(memory.buffer, at.blocks, blocks.length).set(blocks);
			blockCount = blocks.length / 3;
		},
		regretMatch() {
			exports.matchRegretBlocks(at.regret, at.strategy, at.blocks, blockCount, at.total);
		},
	};
}
