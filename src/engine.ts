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
import { ENGINE_SHARED_WASM } from './wasm/engine-shared.ts';
import type { ShardPlan } from './parallel.ts';
import { WORKER_START_ERROR, WORKER_START_MS } from './parallel.ts';

/** The parts of the WebAssembly API used here, typed locally: the project builds without DOM typings. */
interface WasmApi {
	validate(bytes: Uint8Array): boolean;
	Module: new (bytes: Uint8Array) => object;
	Instance: new (module: object, imports: object) => { exports: Record<string, unknown> };
	Memory: new (descriptor: { initial: number; maximum?: number; shared?: boolean }) => { buffer: ArrayBuffer };
}

const wasm = (globalThis as unknown as { WebAssembly?: WasmApi }).WebAssembly;
const modules: Record<'plain' | 'shared', object | null | undefined> = { plain: undefined, shared: undefined };

/** The compiled engine, over plain or shared memory; null where unavailable. */
export function compiledEngine(kind: 'plain' | 'shared'): object | null {
	if (modules[kind] !== undefined) return modules[kind]!;
	modules[kind] = null;
	try {
		if (!wasm) return null;
		const text = kind === 'plain' ? ENGINE_WASM : ENGINE_SHARED_WASM;
		const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
		if (!wasm.validate(bytes)) return null;
		modules[kind] = new wasm.Module(bytes);
	} catch {
		modules[kind] = null;
	}
	return modules[kind]!;
}

function compiled(): object | null {
	return compiledEngine('plain');
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
	/** Release worker threads, if any. */
	close(): void;
	/** Threads doing the work, this one included. */
	readonly threads: number;
}

/** What an engine worker needs; see src/engine-worker.ts. */
export interface EngineWorkerSetup {
	readonly memory: unknown;
	readonly module: unknown;
	readonly header: number;
	readonly maxActions: number;
	readonly exchange: readonly [number, number, number, number];
	readonly shard: readonly [number, number, number];
	readonly entryNodes: Int32Array;
	readonly rootMe: number;
	readonly rootOpp: number;
	readonly partial: number;
	readonly stride: number;
	readonly control: SharedArrayBuffer;
	readonly settings: SharedArrayBuffer;
}

/** How a pool starts its workers; the platform layer supplies it. */
export type SpawnEngineWorker = (setup: EngineWorkerSetup, onError: (error: Error) => void) => { terminate(): void };

/** Control slots shared with engine workers. */
export const ENGINE_CONTROL = { generation: 0, done: 1, command: 2, mode: 3, traverser: 4, ready: 5, size: 8 } as const;

/**
 * Lay a spot out in a fresh memory and instantiate the engine over it, or
 * null where unavailable. With `pool`, the memory is shared and that many
 * threads split the runouts at the plan's round, as src/parallel.ts does for
 * the JavaScript engine.
 */
export function createEngine(
	input: EngineInput,
	pool?: { plan: ShardPlan; threads: number; spawn: SpawnEngineWorker },
): Engine | null {
	const shared = pool !== undefined;
	const compiledModule = compiledEngine(shared ? 'shared' : 'plain');
	if (!compiledModule || !wasm) return null;
	const { tree, runouts, layout, active, hands } = input;
	const threads = pool ? pool.threads : 1;

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
	const maxCount = Math.max(4, ...active.count);
	const stride = Math.ceil(maxCount / 4) * 4;
	const maxActions = Math.max(1, layout.maxActions);
	const depths = treeDepth(tree) + 2;
	const rowBytes = stride * 4;
	const depthBytes = rowBytes * (3 + 2 * maxActions);

	const pieces: { data: ArrayBufferView | null; bytes: number }[] = [];
	const add = (data: ArrayBufferView | null, bytes = data ? data.byteLength : 0): number => {
		pieces.push({ data, bytes: Math.ceil(Math.max(bytes, 4) / 16) * 16 });
		return pieces.length - 1;
	};
	// Shared by every thread, in header order.
	const common = [
		add(tree.kind), add(tree.round), add(Uint8Array.from(tree.player, (p) => (p < 0 ? 255 : p))), add(tree.firstEdge),
		add(tree.numEdges), add(tree.edgeChild), add(tree.payoff), add(layout.offset), add(layout.rowStart),
		add(active.roundBase), add(active.start), add(Int32Array.from(active.count)), add(active.cardA), add(active.cardB),
		add(active.strength), add(active.packed), add(Float32Array.from(active.multiplicity)), add(active.memberStart),
		add(active.memberA), add(active.memberB), add(upRound), add(upStart), add(hands.up),
		add(hands.sameStart), add(hands.same), add(childRound), add(childStart), add(orbitRound), add(orbitStart),
		add(input.runoutWeight),
		add(null, layout.totalSlots * 4), // regret
		add(null, layout.totalSlots * 4), // strategy sums
	];
	const REGRET = common[common.length - 2];
	const SUMS = common[common.length - 1];
	// Each thread's own.
	const own = Array.from({ length: threads }, () => ({
		buffers: add(null, depths * depthBytes),
		cardSums: add(null, 52 * 8 + stride * 8),
		rootMe: add(null, rowBytes),
		rootOpp: add(null, rowBytes),
		header: add(null, 40 * 4),
	}));
	// The exchange between threads.
	const entries = pool ? pool.plan.entryNodes.length : 0;
	const entryIndexOf = pool ? add(pool.plan.entryIndexOf) : -1;
	const reach = pool ? add(null, entries * 2 * rowBytes) : -1;
	const values = pool ? add(null, entries * rowBytes) : -1;
	const partials = pool ? add(null, (threads - 1) * entries * rowBytes) : -1;

	const offsets: number[] = [];
	let total = 64;
	for (const piece of pieces) {
		offsets.push(total);
		total += piece.bytes;
	}
	if (total > 0xffff0000) return null; // past wasm32's 4 GB
	const pages = Math.ceil(total / 65536) + 1;
	const memory = shared ? new wasm.Memory({ initial: pages, maximum: pages, shared: true }) : new wasm.Memory({ initial: pages });
	const bytes = new Uint8Array(memory.buffer);
	pieces.forEach((piece, i) => {
		if (piece.data) bytes.set(new Uint8Array(piece.data.buffer, piece.data.byteOffset, piece.data.byteLength), offsets[i]);
	});
	for (const mine of own) {
		const head = new Uint32Array(memory.buffer, offsets[mine.header], 40);
		common.forEach((slot, i) => (head[i] = offsets[slot]));
		head[common.length] = offsets[mine.buffers];
		head[common.length + 1] = depthBytes;
		head[common.length + 2] = rowBytes;
		head[common.length + 3] = offsets[mine.cardSums];
		head[common.length + 4] = input.chipScale;
	}

	const instance = new wasm.Instance(compiledModule, { env: { memory, abort: () => { throw new Error('engine abort'); } } });
	const exports = instance.exports as unknown as EngineExports;
	exports.init(offsets[own[0].header]);
	exports.setMaxActions(maxActions);

	const regret = new Float32Array(memory.buffer, offsets[REGRET], layout.totalSlots);
	const strategySum = new Float32Array(memory.buffer, offsets[SUMS], layout.totalSlots);
	const me = new Float32Array(memory.buffer, offsets[own[0].rootMe], stride);
	const opp = new Float32Array(memory.buffer, offsets[own[0].rootOpp], stride);
	const result = new Float64Array(COMBOS);
	const rootList = (player: 0 | 1): [number, number] => {
		const slot = active.roundBase[0] * 2 + player;
		return [active.start[slot], active.count[slot]];
	};
	const settingsFor = (mode: number, iterWeight: number, dcfr: boolean): [number, number, number, number, number] => {
		if (mode === Mode.Train && dcfr) {
			const { keepPositive, keepNegative, keepSum } = dcfrFactors(iterWeight);
			return [keepPositive, keepNegative, keepSum, 1, 0];
		}
		return [1, 1, 1, iterWeight, dcfr ? 0 : 1];
	};

	// Threads: workers over the same memory, each with its own header.
	let control: Int32Array | null = null;
	let settings: Float64Array | null = null;
	const workers: { terminate(): void }[] = [];
	let failure: Error | null = null;
	if (pool) {
		const plan = pool.plan;
		const controlBuffer = new SharedArrayBuffer(ENGINE_CONTROL.size * 4);
		const settingsBuffer = new SharedArrayBuffer(8 * 8);
		control = new Int32Array(controlBuffer);
		settings = new Float64Array(settingsBuffer);
		exports.setExchange(offsets[entryIndexOf], offsets[reach], offsets[values], stride);
		for (let w = 1; w < threads; w++) {
			const setup: EngineWorkerSetup = {
				memory, module: compiledModule, header: offsets[own[w].header], maxActions,
				exchange: [offsets[entryIndexOf], offsets[reach], offsets[values], stride],
				shard: [plan.round, plan.bounds[w], plan.bounds[w + 1]],
				entryNodes: plan.entryNodes,
				rootMe: offsets[own[w].rootMe], rootOpp: offsets[own[w].rootOpp],
				partial: offsets[partials] + (w - 1) * entries * rowBytes,
				stride, control: controlBuffer, settings: settingsBuffer,
			};
			workers.push(pool.spawn(setup, (error) => {
				failure ??= error;
				Atomics.store(control!, ENGINE_CONTROL.ready, threads);
				Atomics.add(control!, ENGINE_CONTROL.done, threads);
				Atomics.notify(control!, ENGINE_CONTROL.done);
				Atomics.notify(control!, ENGINE_CONTROL.ready);
			}));
		}
		// A worker that fails to start reports it by an event, which cannot
		// be delivered while this thread waits here, so the wait is bounded.
		const deadline = Date.now() + WORKER_START_MS;
		for (;;) {
			const ready = Atomics.load(control, ENGINE_CONTROL.ready);
			if (ready >= threads - 1 || failure) break;
			if (Date.now() > deadline) failure = new Error(WORKER_START_ERROR);
			else Atomics.wait(control, ENGINE_CONTROL.ready, ready, 20);
		}
		if (failure) {
			for (const worker of workers) worker.terminate();
			throw failure;
		}
	}

	const run = (mode: number, traverser: 0 | 1, iterWeight: number, dcfr: boolean): Float64Array => {
		for (const player of [0, 1] as const) {
			const [from, count] = rootList(player);
			const into = player === traverser ? me : opp;
			const weights = input.players[player].weights;
			for (let i = 0; i < count; i++) into[i] = weights[active.list[from + i]];
		}
		const [positive, negative, sum, weight, clamp] = settingsFor(mode, iterWeight, dcfr);
		let at: number;
		if (!pool) {
			at = exports.run(mode, traverser, offsets[own[0].rootMe], offsets[own[0].rootOpp], positive, negative, sum, weight, clamp);
		} else {
			const plan = pool.plan;
			// Collect: walk above the split, recording what the workers need.
			exports.setShard(plan.round, 0, 0);
			exports.setPhase(1, 0);
			exports.run(mode, traverser, offsets[own[0].rootMe], offsets[own[0].rootOpp], positive, negative, sum, weight, clamp);
			// Every thread walks its slice of the split round.
			settings!.set([positive, negative, sum, weight, clamp]);
			Atomics.store(control!, ENGINE_CONTROL.done, 0);
			Atomics.store(control!, ENGINE_CONTROL.mode, mode);
			Atomics.store(control!, ENGINE_CONTROL.traverser, traverser);
			Atomics.store(control!, ENGINE_CONTROL.command, 0);
			Atomics.add(control!, ENGINE_CONTROL.generation, 1);
			Atomics.notify(control!, ENGINE_CONTROL.generation);
			exports.setShard(plan.round, plan.bounds[0], plan.bounds[1]);
			exports.setPhase(0, 1);
			const valueView = new Float32Array(memory.buffer, offsets[values], entries * stride);
			for (let entry = 0; entry < entries; entry++) {
				const slot = offsets[reach] + entry * 2 * rowBytes;
				const out = exports.runChance(mode, traverser, plan.entryNodes[entry], slot, slot + rowBytes, positive, negative, sum, weight, clamp);
				valueView.set(new Float32Array(memory.buffer, out, stride), entry * stride);
			}
			for (;;) {
				const done = Atomics.load(control!, ENGINE_CONTROL.done);
				if (done >= threads - 1 || failure) break;
				Atomics.wait(control!, ENGINE_CONTROL.done, done, 50);
			}
			if (failure) throw failure;
			const partialView = new Float32Array(memory.buffer, offsets[partials], (threads - 1) * entries * stride);
			for (let w = 0; w < threads - 1; w++) {
				for (let i = 0; i < entries * stride; i++) valueView[i] += partialView[w * entries * stride + i];
			}
			// Finish above the split from the totals, now applying updates.
			exports.setShard(plan.round, 0, 0);
			exports.setPhase(2, 1);
			at = exports.run(mode, traverser, offsets[own[0].rootMe], offsets[own[0].rootOpp], positive, negative, sum, weight, clamp);
			exports.setPhase(0, 1);
			exports.setShard(-1, 0, 0);
		}
		const [, count] = rootList(traverser);
		const values32 = new Float32Array(memory.buffer, at, count);
		for (let i = 0; i < count; i++) result[i] = values32[i];
		return result;
	};

	return {
		regret,
		strategySum,
		threads,
		root(dcfr) {
			return (mode, traverser, iterWeight) => run(mode, traverser, iterWeight, dcfr);
		},
		close() {
			if (!control) return;
			Atomics.store(control, ENGINE_CONTROL.command, 1);
			Atomics.add(control, ENGINE_CONTROL.generation, 1);
			Atomics.notify(control, ENGINE_CONTROL.generation);
			for (const worker of workers) worker.terminate();
		},
	};
}

/** The engine's exports. */
export interface EngineExports {
	init(header: number): void;
	setMaxActions(count: number): void;
	setShard(round: number, start: number, end: number): void;
	setExchange(entries: number, reach: number, values: number, stride: number): void;
	setPhase(phase: number, apply: number): void;
	run(mode: number, traverser: number, me: number, opp: number, positive: number, negative: number, sum: number, weight: number, clamp: number): number;
	runChance(mode: number, traverser: number, node: number, me: number, opp: number, positive: number, negative: number, sum: number, weight: number, clamp: number): number;
}
