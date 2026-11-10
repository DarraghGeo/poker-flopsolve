/**
 * The WebAssembly traversal engine, set up.
 *
 * Purpose: lay a prepared spot out in one WebAssembly memory for
 * `assembly/engine.ts`, and give the solver its storage and a root traversal.
 *
 * The engine keeps the accumulators in its own memory as 32-bit floats; the
 * solver's `regret` and `strategySum` are views onto them, so everything that
 * reads storage from JavaScript — strategy queries, warm starts, `valuesAt` —
 * sees the very same numbers. It runs where WebAssembly SIMD is available,
 * on one thread or several; otherwise the JavaScript traversal in cfr.ts
 * runs. A second build, which only `poker-flopsolve/wasm-storage` carries,
 * keeps 16-bit and compact storage the same way (`EngineInput.storage`).
 *
 * WebAssembly memory is one buffer, but Chromium lets it reach wasm32's full
 * 4 GiB, plain or shared, made at that size or grown to it, where it refuses
 * any ArrayBuffer over 2 GiB less 2 MiB (measured in Chromium 153 by
 * bin/memory-ceiling.ts; issue #84). So compact storage needs no chunks of
 * its own in the engine: its chunks are regions of the one memory, laid out
 * as the JavaScript engine's buffers are.
 */

import { COMBOS } from './cards.ts';
import type { ActiveLists, CompactPlan, Layout, PlayerIndex, RegretStore, RootTraversal, SamplingPlan, SumStore } from './cfr.ts';
import { dcfrFactors, Mode, treeDepth } from './cfr.ts';
import type { HandSpace } from './hands.ts';
import type { Runouts } from './runouts.ts';
import type { Tree } from './tree.ts';
import { ENGINE_WASM } from './wasm/engine.ts';
import { ENGINE_SHARED_WASM } from './wasm/engine-shared.ts';
import type { ShardPlan } from './parallel.ts';
import { awaitThreads, THREAD_FAILED_ERROR, WORKER_START_ERROR, WORKER_START_MS } from './parallel.ts';

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
	return compileInto(modules, kind, kind === 'plain' ? ENGINE_WASM : ENGINE_SHARED_WASM);
}

/** Compile base64 WebAssembly into `cache[kind]` once; null there where unavailable. */
function compileInto(cache: Record<'plain' | 'shared', object | null | undefined>, kind: 'plain' | 'shared', text: string): object | null {
	if (cache[kind] !== undefined) return cache[kind]!;
	cache[kind] = null;
	try {
		if (!wasm) return null;
		const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
		if (!wasm.validate(bytes)) return null;
		cache[kind] = new wasm.Module(bytes);
	} catch {
		cache[kind] = null;
	}
	return cache[kind]!;
}

/**
 * The engine with 16-bit and compact storage (issue #84), as base64 for plain
 * and shared memory. Only `poker-flopsolve/wasm-storage` holds the bytes, so
 * a build that never imports it carries none of them; a solve opts in by
 * passing it as `SolveOptions.wasmStorage`.
 */
export interface WasmStorage {
	readonly plain: string;
	readonly shared: string;
}

const storageModules = new WeakMap<WasmStorage, Record<'plain' | 'shared', object | null | undefined>>();

/** The storage engine compiled, over plain or shared memory; null where unavailable. */
function compiledStorage(source: WasmStorage, kind: 'plain' | 'shared'): object | null {
	let cache = storageModules.get(source);
	if (!cache) storageModules.set(source, (cache = { plain: undefined, shared: undefined }));
	return compileInto(cache, kind, source[kind]);
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
	/** Chance sampling's layout, for `Approximations.chanceSampling`; unset for none. */
	readonly sampling?: SamplingPlan;
	/** Bytes left unused below the layout, rounded up to 16; tests set it to place every pointer past 2 GiB. */
	readonly lowBytes?: number;
	/**
	 * 16-bit or compact storage, run by the storage engine `source` holds;
	 * unset for 32-bit storage on the default engine. `quantised` keeps
	 * the nodes before `compact.from` (all of them without `compact`) at 16
	 * bits, as `precision: 'i16'` does.
	 */
	readonly storage?: { readonly source: WasmStorage; readonly quantised: boolean; readonly compact: CompactPlan | null };
}

/** Compact storage's arrays, per chunk, as `Context` holds them; views onto the engine's memory. */
export interface EngineCompact {
	readonly regret: (Int8Array | Float32Array)[];
	readonly handShift: Uint8Array[] | null;
	readonly sum: Uint8Array[] | null;
	readonly sumShift: Uint8Array[] | null;
	readonly scale: Float64Array | null;
}

/** A running engine. */
export interface Engine {
	/** The accumulators, as views onto the engine's memory: 32-bit, or 16-bit with `EngineInput.storage`. */
	readonly regret: RegretStore;
	readonly strategySum: SumStore;
	/** With 16-bit storage, the per-block scales `Context.regretScale` and `sumScale` hold; else null. */
	readonly regretScale: Float64Array | null;
	readonly sumScale: Float64Array | null;
	/** With compact storage, its arrays; else null. */
	readonly compact: EngineCompact | null;
	/** Chance sampling's state, as views onto the engine's memory; null without sampling. */
	readonly sampling: { baseline: Float32Array; lastWalk: Int32Array; lastUpdate: Int32Array } | null;
	/** With shared storage, `Context.discounted` as a view onto the engine's memory; else null. */
	readonly discounted: Int32Array | null;
	/** Install as the solver's root traversal; `dcfr` picks the update rule. */
	root(dcfr: boolean): RootTraversal;
	/** Release worker threads, if any. */
	close(): void;
	/** Threads doing the work, this one included. */
	readonly threads: number;
	/** With threads, where each traversal's time went (see `PROFILE`); null on one thread. */
	readonly profile: Float64Array | null;
}

/**
 * Slots of `Engine.profile`, milliseconds summed over every threaded
 * traversal (issue #133): the main thread's walk above the split before
 * the threads start (`collect`) and after they finish (`override`), its
 * wait for the others, adding their partial values, and from `busy` on
 * the time each thread spent walking boards, the main thread's first;
 * `run` is the whole threaded traversal. A few clock reads a thread a
 * traversal, so it is always on.
 */
export const PROFILE = { traversals: 0, collect: 1, override: 2, wait: 3, reduce: 4, run: 5, busy: 6 } as const;

/** Each threaded run's profile, by the solver it runs for: read by benches, not part of the API. */
export const threadProfiles = new WeakMap<object, Float64Array>();

/** The split round's boards in the order threads take them, and each board's last walk time, per traverser. */
export interface ScheduleViews {
	readonly order: Int32Array;
	readonly cost: Float64Array;
}

/** Bytes of a schedule for `boards` boards. */
export function scheduleBytes(boards: number): number {
	return Math.ceil(boards / 2) * 8 + 2 * boards * 8;
}

/** A schedule's views onto its buffer. */
export function scheduleViews(buffer: SharedArrayBuffer, boards: number): ScheduleViews {
	return {
		order: new Int32Array(buffer, 0, boards),
		cost: new Float64Array(buffer, Math.ceil(boards / 2) * 8, 2 * boards),
	};
}

/** What an engine worker needs; see src/engine-worker.ts. */
export interface EngineWorkerSetup {
	readonly memory: unknown;
	readonly module: unknown;
	readonly header: number;
	readonly maxActions: number;
	readonly exchange: readonly [number, number, number, number];
	/** The split round and its number of boards. */
	readonly shard: readonly [number, number];
	readonly entryNodes: Int32Array;
	readonly rootMe: number;
	readonly rootOpp: number;
	/** Where each board's values for each entry go: `boards × entries` rows, board-major. */
	readonly boardValues: number;
	/** The boards' walking order and their last costs; see `scheduleViews`. */
	readonly schedule: SharedArrayBuffer;
	readonly stride: number;
	readonly control: SharedArrayBuffer;
	readonly settings: SharedArrayBuffer;
	/** With shared storage: where the discount marks, the block table and the weighted nodes (or 0) sit. */
	readonly shared?: readonly [number, number, number];
	/** Set for the storage engine, whose updates need the iteration on every walk. */
	readonly storage?: boolean;
	/**
	 * With chance sampling, `setSampling`'s arguments as the main thread
	 * passed them: its state is in the shared memory, and each thread walks
	 * and marks only its own runouts' deals.
	 */
	readonly sampling?: SamplingArgs;
	/** `Engine.profile`'s buffer and this thread's slot in it. */
	readonly profile: readonly [SharedArrayBuffer, number];
}

/** `EngineExports.setSampling`'s arguments, in order. */
export type SamplingArgs = Parameters<EngineExports['setSampling']>;

/** How a pool starts its workers; the platform layer supplies it. */
export type SpawnEngineWorker = (setup: EngineWorkerSetup, onError: (error: Error) => void) => { terminate(): void };

/** The most memory the engine lays out: just under wasm32's 4 GB. */
const MAX_MEMORY = 0xffff0000;

/**
 * Control slots shared with engine workers. `failed` is set, never cleared,
 * once any thread's part of a step threw: the main thread waits in
 * `Atomics.wait` and so never sees a worker's error event while a step runs.
 */
export const ENGINE_CONTROL = { generation: 0, done: 1, command: 2, mode: 3, traverser: 4, ready: 5, failed: 6, next: 7, size: 8 } as const;

/**
 * Lay a spot out in a fresh memory and instantiate the engine over it, or
 * null where unavailable. With `pool`, the memory is shared and that many
 * threads split the plan's round between them, each taking the next board
 * off a shared queue (`runThreaded`), where the JavaScript engine's pool in
 * src/parallel.ts gives each worker a fixed slice.
 */
export function createEngine(
	input: EngineInput,
	pool?: {
		plan: ShardPlan;
		threads: number;
		spawn: SpawnEngineWorker;
		/** The shortest a step waits for the other threads; see `awaitThreads` in src/parallel.ts. */
		backstopFloorMs?: number;
	},
): Engine | null {
	const shared = pool !== undefined;
	const storage = input.storage ?? null;
	const compiledModule = storage
		? compiledStorage(storage.source, shared ? 'shared' : 'plain')
		: compiledEngine(shared ? 'shared' : 'plain');
	if (!compiledModule || !wasm) return null;
	const { tree, runouts, layout, active, hands } = input;
	const compact = storage?.compact ?? null;
	const quantised = storage?.quantised ?? false;
	// Its accumulators alone would pass wasm32's 4 GB, so no engine; checked
	// before anything is built. Such a layout is also the only kind that
	// holds offsets as Float64, which the engine's 32-bit offset table could
	// not take.
	const width = quantised ? 2 : 4;
	const compactBytes = !compact
		? 0
		: compact.float
			? layout.compactSlots * 4
			: (layout.compactSlots + (compact.perHand ? layout.compactHands : 0)) * (compact.sums ? 2 : 1);
	if (layout.totalSlots * width * 2 + compactBytes > MAX_MEMORY || !(layout.offset instanceof Int32Array)) return null;
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
		add(null, layout.totalSlots * width), // regret
		add(null, layout.totalSlots * width), // strategy sums
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
	// Each board's values, apart, so their sum does not depend on which thread walked which.
	const boardValues = pool ? add(null, pool.plan.boards * entries * rowBytes) : -1;
	// Chance sampling, only when asked for.
	const plan = input.sampling;
	const sample = plan
		? {
				baseOffset: add(plan.baseOffset), boardOffset: add(plan.boardOffset), walkOffset: add(plan.walkOffset),
				blockOffset: add(layout.blockOffset), baseline: add(null, plan.values * 4), lastWalk: add(null, plan.walks * 4),
				lastUpdate: add(null, plan.blocks * 4),
			}
		: null;
	// History sharing's once-an-iteration discount marks, only when storage is shared.
	const share = layout.shared
		? {
				marks: add(null, layout.blocks * 4),
				blockOffset: sample ? sample.blockOffset : add(layout.blockOffset),
				weighted: layout.reachWeighted ? add(layout.reachWeighted) : -1,
			}
		: null;
	// 16-bit and compact storage's settings, scales and chunks, only on the storage engine.
	const chunks = compact ? layout.chunkSlots.length : 0;
	const stored = storage
		? {
				block: add(null, 128),
				blockOffset: sample ? sample.blockOffset : share ? share.blockOffset : add(layout.blockOffset),
				regretScale: quantised ? add(null, layout.blocks * 8) : -1,
				sumScale: quantised ? add(null, layout.blocks * 8) : -1,
				compactChunk: compact ? add(layout.compactChunk) : -1,
				handOffset: compact ? add(Int32Array.from(layout.handOffset!)) : -1,
				tables: compact ? add(null, chunks * 4 * 5) : -1,
				regrets: layout.chunkSlots.map((slots) => add(null, slots * (compact!.float ? 4 : 1))),
				shifts: compact?.perHand ? layout.chunkHands.map((count) => add(null, count)) : [],
				sums: compact?.sums ? layout.chunkSlots.map((slots) => add(null, slots)) : [],
				sumShifts: compact?.sums ? layout.chunkHands.map((count) => add(null, count)) : [],
				compactScale: compact && !compact.perHand && !compact.float ? add(null, layout.blocks * 8) : -1,
			}
		: null;

	const offsets: number[] = [];
	let total = 64 + Math.ceil(Math.max(input.lowBytes ?? 0, 0) / 16) * 16;
	for (const piece of pieces) {
		offsets.push(total);
		total += piece.bytes;
	}
	if (total > MAX_MEMORY) return null;
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
		if (stored) head[common.length + 5] = offsets[stored.block];
	}
	if (stored) {
		const at = (slot: number): number => (slot >= 0 ? offsets[slot] : 0);
		const block = new Uint32Array(memory.buffer, offsets[stored.block], 20);
		block.set([
			quantised ? 1 : 0, compact ? compact.from : 255, !compact ? 0 : compact.float ? 3 : compact.perHand ? 1 : 2,
			compact?.sums ? 1 : 0, compact?.stochastic ? 1 : 0, compact?.steps ?? 127,
			at(stored.regretScale), at(stored.sumScale), offsets[stored.blockOffset], at(stored.compactChunk),
			at(stored.handOffset),
		]);
		if (compact) {
			// Per chunk: where its regrets, hand scales, sums and sum scales sit, and its first slot.
			const tables = offsets[stored.tables];
			const table = new Uint32Array(memory.buffer, tables, chunks * 5);
			for (let c = 0; c < chunks; c++) {
				table[c] = offsets[stored.regrets[c]];
				table[chunks + c] = stored.shifts.length ? offsets[stored.shifts[c]] : 0;
				table[2 * chunks + c] = stored.sums.length ? offsets[stored.sums[c]] : 0;
				table[3 * chunks + c] = stored.sumShifts.length ? offsets[stored.sumShifts[c]] : 0;
				table[4 * chunks + c] = layout.chunkStart[c] >>> 0;
			}
			block.set([tables, tables + chunks * 4, tables + chunks * 8, tables + chunks * 12, tables + chunks * 16, at(stored.compactScale)], 11);
		}
	}
	// The update rule's factors, as float64, which the storage engine reads before each walk.
	const factors = stored ? new Float64Array(memory.buffer, offsets[stored.block] + 80, 4) : null;

	const instance = new wasm.Instance(compiledModule, { env: { memory, abort: () => { throw new Error('engine abort'); } } });
	const exports = instance.exports as unknown as EngineExports;
	exports.init(offsets[own[0].header]);
	exports.setMaxActions(maxActions);
	let samplingViews: Engine['sampling'] = null;
	let samplingArgs: SamplingArgs | null = null;
	if (plan && sample) {
		let mask = 0;
		for (let r = 0; r < plan.rounds.length; r++) if (plan.rounds[r]) mask |= 1 << r;
		samplingArgs = [
			mask, plan.p, plan.every, plan.unbiased ? 1 : 0, plan.catchUp ? 1 : 0,
			offsets[sample.baseOffset], offsets[sample.boardOffset], offsets[sample.walkOffset],
			offsets[sample.baseline], offsets[sample.lastWalk], offsets[sample.lastUpdate], offsets[sample.blockOffset],
		];
		const a = samplingArgs;
		exports.setSampling(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11]);
		samplingViews = {
			baseline: new Float32Array(memory.buffer, offsets[sample.baseline], plan.values),
			lastWalk: new Int32Array(memory.buffer, offsets[sample.lastWalk], plan.walks),
			lastUpdate: new Int32Array(memory.buffer, offsets[sample.lastUpdate], plan.blocks),
		};
	}

	const weightedAt = share && share.weighted >= 0 ? offsets[share.weighted] : 0;
	if (share) exports.setShared(offsets[share.marks], offsets[share.blockOffset], weightedAt);
	const discounted = share ? new Int32Array(memory.buffer, offsets[share.marks], layout.blocks) : null;

	const regret: RegretStore = quantised
		? new Int16Array(memory.buffer, offsets[REGRET], layout.totalSlots)
		: new Float32Array(memory.buffer, offsets[REGRET], layout.totalSlots);
	const strategySum: SumStore = quantised
		? new Uint16Array(memory.buffer, offsets[SUMS], layout.totalSlots)
		: new Float32Array(memory.buffer, offsets[SUMS], layout.totalSlots);
	const scaleView = (slot: number): Float64Array | null =>
		slot >= 0 ? new Float64Array(memory.buffer, offsets[slot], layout.blocks) : null;
	const compactViews: EngineCompact | null = stored && compact
		? {
				regret: stored.regrets.map((slot, c) =>
					compact.float
						? new Float32Array(memory.buffer, offsets[slot], layout.chunkSlots[c])
						: new Int8Array(memory.buffer, offsets[slot], layout.chunkSlots[c]),
				),
				handShift: compact.perHand ? stored.shifts.map((slot, c) => new Uint8Array(memory.buffer, offsets[slot], layout.chunkHands[c])) : null,
				sum: compact.sums ? stored.sums.map((slot, c) => new Uint8Array(memory.buffer, offsets[slot], layout.chunkSlots[c])) : null,
				sumShift: compact.sums ? stored.sumShifts.map((slot, c) => new Uint8Array(memory.buffer, offsets[slot], layout.chunkHands[c])) : null,
				scale: scaleView(stored.compactScale),
			}
		: null;
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
	let profile: Float64Array | null = null;
	let schedule: ScheduleViews | null = null;
	const workers: { terminate(): void }[] = [];
	let failure: Error | null = null;
	if (pool) {
		const plan = pool.plan;
		const controlBuffer = new SharedArrayBuffer(ENGINE_CONTROL.size * 4);
		const settingsBuffer = new SharedArrayBuffer(8 * 8);
		control = new Int32Array(controlBuffer);
		settings = new Float64Array(settingsBuffer);
		const profileBuffer = new SharedArrayBuffer(8 * (PROFILE.busy + threads));
		profile = new Float64Array(profileBuffer);
		const scheduleBuffer = new SharedArrayBuffer(scheduleBytes(plan.boards));
		schedule = scheduleViews(scheduleBuffer, plan.boards);
		for (let i = 0; i < plan.boards; i++) schedule.order[i] = i;
		exports.setExchange(offsets[entryIndexOf], offsets[reach], offsets[values], stride);
		for (let w = 1; w < threads; w++) {
			const setup: EngineWorkerSetup = {
				memory, module: compiledModule, header: offsets[own[w].header], maxActions,
				exchange: [offsets[entryIndexOf], offsets[reach], offsets[values], stride],
				shard: [plan.round, plan.boards],
				entryNodes: plan.entryNodes,
				rootMe: offsets[own[w].rootMe], rootOpp: offsets[own[w].rootOpp],
				boardValues: offsets[boardValues], schedule: scheduleBuffer,
				stride, control: controlBuffer, settings: settingsBuffer,
				...(share ? { shared: [offsets[share.marks], offsets[share.blockOffset], weightedAt] as const } : {}),
				...(stored ? { storage: true } : {}),
				...(samplingArgs ? { sampling: samplingArgs } : {}),
				profile: [profileBuffer, PROFILE.busy + w],
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

	const failed = (): Error | null =>
		failure ?? (control && Atomics.load(control, ENGINE_CONTROL.failed) ? new Error(THREAD_FAILED_ERROR) : null);

	// The iteration a step is for, and its rule, which shared storage's threads need.
	let iteration = 0;
	let dcfrRule = 0;
	const run = (asked: number, traverser: 0 | 1, iterWeight: number, dcfr: boolean): Float64Array => {
		// Once any thread has failed, so does every step after, before it
		// touches anything.
		const dead = failed();
		if (dead) throw dead;
		// The engine knows three modes; the current profile is its Train
		// with updates off.
		const apply = asked === Mode.Current ? 0 : 1;
		const mode = asked === Mode.Current ? Mode.Train : asked;
		for (const player of [0, 1] as const) {
			const [from, count] = rootList(player);
			const into = player === traverser ? me : opp;
			const weights = input.players[player].weights;
			for (let i = 0; i < count; i++) into[i] = weights[active.list[from + i]];
		}
		const [positive, negative, sum, weight, clamp] = settingsFor(mode, iterWeight, dcfr);
		iteration = mode === Mode.Train ? iterWeight : 0;
		dcfrRule = dcfr ? 1 : 0;
		if (plan || share || stored) exports.setIteration(iteration, dcfrRule);
		// CFR+ at 16 bits or compact floors a negative regret, as `updateQuantised`
		// and `updateCompact` do (one only a warm start could bring); 32-bit storage keeps it.
		factors?.set([positive, mode === Mode.Train && !dcfr ? 0 : negative, sum, weight]);
		let at: number;
		if (!pool) {
			if (apply === 0) exports.setPhase(0, 0);
			try {
				at = exports.run(mode, traverser, offsets[own[0].rootMe], offsets[own[0].rootOpp], positive, negative, sum, weight, clamp) >>> 0;
			} finally {
				if (apply === 0) exports.setPhase(0, 1);
			}
		} else {
			try {
				at = runThreaded(mode, traverser, apply, positive, negative, sum, weight, clamp);
			} catch (error) {
				// This thread's own part may have thrown with the workers still
				// walking; no later step may run over them.
				Atomics.store(control!, ENGINE_CONTROL.failed, 1);
				throw error;
			}
		}
		const [, count] = rootList(traverser);
		const values32 = new Float32Array(memory.buffer, at, count);
		for (let i = 0; i < count; i++) result[i] = values32[i];
		return result;
	};

	/** One threaded traversal, returning where the root values are. */
	const runThreaded = (
		mode: number, traverser: 0 | 1, apply: number,
		positive: number, negative: number, sum: number, weight: number, clamp: number,
	): number => {
		const plan = pool!.plan;
		const { order, cost } = schedule!;
		const clock = performance.now();
		// Collect: walk above the split, recording what the workers need.
		exports.setShard(plan.round, 0, 0);
		exports.setPhase(1, 0);
		exports.run(mode, traverser, offsets[own[0].rootMe], offsets[own[0].rootOpp], positive, negative, sum, weight, clamp);
		const collected = performance.now();
		// Costliest boards first, by what they took on this traverser's last
		// training walk, so the last boards anyone takes are the cheap ones.
		// Only training walks record costs: a best-response or current-profile
		// pass, unsampled and without updates, costs a board differently.
		const costs = cost.subarray(traverser * plan.boards, (traverser + 1) * plan.boards);
		const timed = mode === Mode.Train && apply === 1;
		order.sort((a, b) => costs[b] - costs[a] || a - b);
		// Every thread takes boards off the order until none are left.
		settings!.set([positive, negative, sum, weight, clamp, apply, iteration, dcfrRule]);
		Atomics.store(control!, ENGINE_CONTROL.done, 0);
		Atomics.store(control!, ENGINE_CONTROL.next, 0);
		Atomics.store(control!, ENGINE_CONTROL.mode, mode);
		Atomics.store(control!, ENGINE_CONTROL.traverser, traverser);
		Atomics.store(control!, ENGINE_CONTROL.command, 0);
		Atomics.add(control!, ENGINE_CONTROL.generation, 1);
		Atomics.notify(control!, ENGINE_CONTROL.generation);
		const dispatched = performance.now();
		exports.setPhase(0, apply);
		const heap = new Float32Array(memory.buffer);
		const into = offsets[boardValues] >>> 2;
		for (;;) {
			const taken = Atomics.add(control!, ENGINE_CONTROL.next, 1);
			if (taken >= plan.boards) break;
			const board = order[taken];
			exports.setShard(plan.round, board, board + 1);
			const started = performance.now();
			for (let entry = 0; entry < entries; entry++) {
				const slot = offsets[reach] + entry * 2 * rowBytes;
				const out = exports.runChance(mode, traverser, plan.entryNodes[entry], slot, slot + rowBytes, positive, negative, sum, weight, clamp) >>> 2;
				heap.copyWithin(into + (board * entries + entry) * stride, out, out + stride);
			}
			if (timed) costs[board] = performance.now() - started;
		}
		const walked = performance.now();
		// A thread whose walk throws says so in `failed` and counts itself
		// done, as its error event cannot reach this thread while it waits.
		// One killed without unwinding does neither, hence the backstop.
		failure ??= awaitThreads(
			control!, ENGINE_CONTROL.done, threads - 1, dispatched, pool!.backstopFloorMs, () => failure !== null,
		);
		const dead = failed();
		if (dead) throw dead;
		const waited = performance.now();
		// The boards' values summed in board order, whoever walked them.
		const valueView = new Float32Array(memory.buffer, offsets[values], entries * stride);
		valueView.fill(0);
		for (let board = 0; board < plan.boards; board++) {
			const rows = into + board * entries * stride;
			for (let i = 0; i < entries * stride; i++) valueView[i] += heap[rows + i];
		}
		const reduced = performance.now();
		// Finish above the split from the totals, now applying updates
		// unless this is a current-profile read.
		exports.setShard(plan.round, 0, 0);
		exports.setPhase(2, apply);
		const at = exports.run(mode, traverser, offsets[own[0].rootMe], offsets[own[0].rootOpp], positive, negative, sum, weight, clamp) >>> 0;
		exports.setPhase(0, 1);
		exports.setShard(-1, 0, 0);
		const p = profile!;
		const finished = performance.now();
		p[PROFILE.traversals]++;
		p[PROFILE.collect] += collected - clock;
		p[PROFILE.busy] += walked - dispatched;
		p[PROFILE.wait] += waited - walked;
		p[PROFILE.reduce] += reduced - waited;
		p[PROFILE.override] += finished - reduced;
		p[PROFILE.run] += finished - clock;
		return at;
	};

	return {
		regret,
		strategySum,
		regretScale: stored ? scaleView(stored.regretScale) : null,
		sumScale: stored ? scaleView(stored.sumScale) : null,
		compact: compactViews,
		sampling: samplingViews,
		discounted,
		threads,
		profile,
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

/**
 * The engine's exports. A pointer one returns is a wasm32 `usize`, which
 * JavaScript receives as a signed 32-bit integer: read it with `>>> 0`, or
 * any address past 2 GiB comes back negative (#62).
 */
export interface EngineExports {
	init(header: number): void;
	setMaxActions(count: number): void;
	setShard(round: number, start: number, end: number): void;
	setExchange(entries: number, reach: number, values: number, stride: number): void;
	setPhase(phase: number, apply: number): void;
	setSampling(
		rounds: number, p: number, every: number, unbiased: number, catchUp: number,
		baseOffsets: number, boardOffsets: number, walkOffsets: number,
		baselines: number, lastWalks: number, lastUpdates: number, blockOffsets: number,
	): void;
	setIteration(t: number, dcfr: number): void;
	setShared(marks: number, blockOffsets: number, weighted: number): void;
	run(mode: number, traverser: number, me: number, opp: number, positive: number, negative: number, sum: number, weight: number, clamp: number): number;
	runChance(mode: number, traverser: number, node: number, me: number, opp: number, positive: number, negative: number, sum: number, weight: number, clamp: number): number;
}
