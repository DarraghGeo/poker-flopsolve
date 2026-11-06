/**
 * The WebAssembly traversal engine, set up.
 *
 * Purpose: lay a prepared spot out in one WebAssembly memory for
 * `assembly/engine.ts`, and give the solver its storage and a root traversal.
 *
 * The engine keeps the accumulators in its own memory as 32-bit floats; the
 * solver's `regret` and `strategySum` are views onto them, so everything that
 * reads storage from JavaScript — strategy queries, warm starts, `valuesAt` —
 * sees the very same numbers. It runs single-threaded, with 32-bit storage,
 * where WebAssembly SIMD is available; otherwise the JavaScript traversal in
 * cfr.ts runs.
 */

import { COMBOS, DECK } from './cards.ts';
import type { ActiveLists, Layout, PlayerIndex, RootTraversal } from './cfr.ts';
import { dcfrFactors, Mode, treeDepth } from './cfr.ts';
import type { HandSpace } from './hands.ts';
import type { Runouts } from './runouts.ts';
import type { Tree } from './tree.ts';
import { ENGINE_WASM } from './wasm/engine.ts';

/** The parts of the WebAssembly API used here, typed locally: the project builds without DOM typings. */
interface WasmApi {
	validate(bytes: Uint8Array): boolean;
	Module: new (bytes: Uint8Array) => object;
	Instance: new (module: object, imports: object) => { exports: Record<string, unknown> };
	Memory: new (descriptor: { initial: number }) => { buffer: ArrayBuffer };
}

const wasm = (globalThis as unknown as { WebAssembly?: WasmApi }).WebAssembly;
let module: object | null | undefined;

function compiled(): object | null {
	if (module !== undefined) return module;
	module = null;
	try {
		if (!wasm) return null;
		const bytes = Uint8Array.from(atob(ENGINE_WASM), (c) => c.charCodeAt(0));
		if (!wasm.validate(bytes)) return null;
		module = new wasm.Module(bytes);
	} catch {
		module = null;
	}
	return module;
}

/** Whether this platform can run the WebAssembly engine. */
export function engineAvailable(): boolean {
	return compiled() !== null;
}

/** What the engine needs from a prepared spot. */
export interface EngineInput {
	readonly tree: Tree;
	readonly runouts: Runouts;
	readonly players: readonly [PlayerIndex, PlayerIndex];
	readonly layout: Layout;
	readonly active: ActiveLists;
	readonly hands: HandSpace;
	readonly runoutWeight: Float64Array;
	readonly chipScale: number;
}

/** A running engine. */
export interface Engine {
	/** The accumulators, as views onto the engine's memory. */
	readonly regret: Float32Array;
	readonly strategySum: Float32Array;
	/** Install as the solver's root traversal; `dcfr` picks the update rule. */
	root(dcfr: boolean): RootTraversal;
}

/** Lay a spot out in a fresh memory and instantiate the engine over it, or null where unavailable. */
export function createEngine(input: EngineInput): Engine | null {
	const compiledModule = compiled();
	if (!compiledModule || !wasm) return null;
	const { tree, runouts, layout, active, hands } = input;

	// Everything copied in, as typed arrays, in header order.
	const flatten = (parts: readonly Int32Array[]): [Int32Array, Int32Array] => {
		const bases = new Int32Array(parts.length + 1);
		for (let i = 0; i < parts.length; i++) bases[i + 1] = bases[i] + parts[i].length;
		const flat = new Int32Array(bases[parts.length]);
		parts.forEach((part, i) => flat.set(part, bases[i]));
		return [bases, flat];
	};
	const [upRound, upStart] = flatten(hands.upStart);
	const [childRound, childStart] = flatten(runouts.childStart);
	const [orbitRound, orbitStart] = flatten(runouts.orbitStart);
	const maxCount = Math.max(1, ...active.count);
	const maxActions = Math.max(1, layout.maxActions);
	const depths = treeDepth(tree) + 2;
	const rowBytes = Math.ceil((maxCount * 4) / 16) * 16;
	const depthBytes = rowBytes * (3 + 2 * maxActions);

	const pieces: { data: ArrayBufferView | null; bytes: number }[] = [];
	const add = (data: ArrayBufferView | null, bytes = data ? data.byteLength : 0): number => {
		pieces.push({ data, bytes: Math.ceil(Math.max(bytes, 4) / 16) * 16 });
		return pieces.length - 1;
	};
	const slots = [
		add(tree.kind), add(tree.round), add(Uint8Array.from(tree.player, (p) => (p < 0 ? 255 : p))), add(tree.firstEdge),
		add(tree.numEdges), add(tree.edgeChild), add(tree.payoff), add(layout.offset), add(layout.rowStart),
		add(active.roundBase), add(active.start), add(Int32Array.from(active.count)), add(active.cardA), add(active.cardB),
		add(active.strength), add(active.tieStart), add(active.ties), add(upRound), add(upStart), add(hands.up),
		add(hands.sameStart), add(hands.same), add(childRound), add(childStart), add(orbitRound), add(orbitStart),
		add(input.runoutWeight),
		add(null, layout.totalSlots * 4), // regret
		add(null, layout.totalSlots * 4), // strategy sums
		add(null, depths * depthBytes), // per-depth buffers
	];
	const rowBytesSlot = slots.length;
	const cardSums = add(null, DECK * 8 + maxCount * 8);
	const rootMe = add(null, maxCount * 4);
	const rootOpp = add(null, maxCount * 4);
	const header = add(null, 40 * 4);

	const offsets: number[] = [];
	let total = 64;
	for (const piece of pieces) {
		offsets.push(total);
		total += piece.bytes;
	}
	if (total > 0xffff0000) return null; // past wasm32's 4 GB
	const memory = new wasm.Memory({ initial: Math.ceil(total / 65536) + 1 });
	const bytes = new Uint8Array(memory.buffer);
	pieces.forEach((piece, i) => {
		if (piece.data) bytes.set(new Uint8Array(piece.data.buffer, piece.data.byteOffset, piece.data.byteLength), offsets[i]);
	});
	const head = new Uint32Array(memory.buffer, offsets[header], 40);
	slots.forEach((slot, i) => (head[i] = offsets[slot]));
	head[slots.length - 0] = depthBytes;
	head[slots.length + 1] = rowBytes;
	head[slots.length + 2] = offsets[cardSums];
	head[slots.length + 3] = input.chipScale;
	void rowBytesSlot;

	const instance = new wasm.Instance(compiledModule, { env: { memory, abort: () => { throw new Error('engine abort'); } } });
	const exports = instance.exports as {
		init(header: number): void;
		setMaxActions(count: number): void;
		run(mode: number, traverser: number, me: number, opp: number, positive: number, negative: number, sum: number, weight: number, clamp: number): number;
	};
	exports.init(offsets[header]);
	exports.setMaxActions(maxActions);

	const regret = new Float32Array(memory.buffer, offsets[slots[27]], layout.totalSlots);
	const strategySum = new Float32Array(memory.buffer, offsets[slots[28]], layout.totalSlots);
	const me = new Float32Array(memory.buffer, offsets[rootMe], maxCount);
	const opp = new Float32Array(memory.buffer, offsets[rootOpp], maxCount);
	const result = new Float64Array(COMBOS);
	const list = (player: 0 | 1): [number, number] => {
		const slot = (active.roundBase[0] + 0) * 2 + player;
		return [active.start[slot], active.count[slot]];
	};

	return {
		regret,
		strategySum,
		root(dcfr) {
			return (mode, traverser, iterWeight) => {
				for (const player of [0, 1] as const) {
					const [from, count] = list(player);
					const into = player === traverser ? me : opp;
					const weights = input.players[player].weights;
					for (let i = 0; i < count; i++) into[i] = weights[active.list[from + i]];
				}
				let positive = 1;
				let negative = 1;
				let sum = 1;
				let weight = iterWeight;
				if (mode === Mode.Train && dcfr) {
					({ keepPositive: positive, keepNegative: negative, keepSum: sum } = dcfrFactors(iterWeight));
					weight = 1;
				}
				const at = exports.run(
					mode, traverser, offsets[rootMe], offsets[rootOpp], positive, negative, sum, weight, dcfr ? 0 : 1,
				);
				const [, count] = list(traverser);
				const values = new Float32Array(memory.buffer, at, count);
				for (let i = 0; i < count; i++) result[i] = values[i];
				return result;
			};
		},
	};
}
