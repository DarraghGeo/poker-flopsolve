/**
 * One thread of a WebAssembly solve: the loop every engine worker runs.
 *
 * Purpose: walk this thread's slice of the runouts at the split round, over
 * the memory every thread shares, each time the main thread signals, until it
 * says exit. The protocol is src/parallel.ts's: the main thread collects the
 * reach each entry needs, every thread walks its slice from each entry, the
 * main thread adds the slices up and finishes. All of it happens in shared
 * WebAssembly memory, so nothing is copied between threads but a few numbers
 * of control.
 *
 * Node runs it from `engine-worker.ts`. The browser build has no file to
 * start a worker from, so `platform/browser.ts` ships this function as its
 * own source text (`Function.prototype.toString`) inside a Blob worker. That
 * is why it must stay self-contained: no imports, no reference to anything
 * outside its body, no nested named functions (a bundler may wrap those in a
 * helper the worker would not have). The control slots are written out as
 * numbers for the same reason; a test pins them to `ENGINE_CONTROL`.
 */

import type { EngineWorkerSetup } from './engine.ts';

/**
 * Serve one solve, returning once the main thread sends exit.
 * @param setup what `createEngine` hands each worker
 */
export function serveEngine(setup: EngineWorkerSetup): void {
	// ENGINE_CONTROL, inlined.
	const GENERATION = 0;
	const DONE = 1;
	const COMMAND = 2;
	const MODE = 3;
	const TRAVERSER = 4;
	const READY = 5;
	const FAILED = 6;
	const EXIT = 1;

	const api = (globalThis as unknown as {
		WebAssembly: { Instance: new (module: unknown, imports: object) => { exports: Record<string, unknown> } };
	}).WebAssembly;
	const memory = setup.memory as { buffer: SharedArrayBuffer };
	const imports = {
		env: {
			memory,
			abort(): never {
				throw new Error('engine abort');
			},
		},
	};
	const engine = new api.Instance(setup.module, imports).exports as unknown as {
		init(header: number): void;
		setMaxActions(count: number): void;
		setShard(round: number, start: number, end: number): void;
		setExchange(entries: number, reach: number, values: number, stride: number): void;
		setPhase(phase: number, apply: number): void;
		setShared(marks: number, blockOffsets: number, weighted: number): void;
		setSampling(
			rounds: number, p: number, every: number, unbiased: number, catchUp: number,
			baseOffsets: number, boardOffsets: number, walkOffsets: number,
			baselines: number, lastWalks: number, lastUpdates: number, blockOffsets: number,
		): void;
		setIteration(t: number, dcfr: number): void;
		runChance(
			mode: number, traverser: number, node: number, me: number, opp: number,
			positive: number, negative: number, sum: number, weight: number, clamp: number,
		): number;
	};
	engine.init(setup.header);
	engine.setMaxActions(setup.maxActions);
	engine.setExchange(setup.exchange[0], setup.exchange[1], setup.exchange[2], setup.exchange[3]);
	engine.setShard(setup.shard[0], setup.shard[1], setup.shard[2]);
	engine.setPhase(0, 1);
	const shared = setup.shared;
	if (shared) engine.setShared(shared[0], shared[1], shared[2]);
	// Chance sampling's state is in the shared memory, at the main thread's offsets.
	const s = setup.sampling;
	if (s) engine.setSampling(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11]);
	// Shared storage discounts by iteration, the storage engine's rounding
	// hashes it, and chance sampling picks deals and catches up by it.
	const needsIteration = shared !== undefined || setup.storage === true || s !== undefined;

	const control = new Int32Array(setup.control);
	const settings = new Float64Array(setup.settings);
	const entries = setup.entryNodes.length;
	const rowBytes = setup.stride * 4;
	const partials = new Float32Array(memory.buffer, setup.partial, entries * setup.stride);
	const reach = setup.exchange[1];

	// Latch the generation before announcing readiness, so no dispatch is missed.
	let generation = Atomics.load(control, GENERATION);
	Atomics.add(control, READY, 1);
	Atomics.notify(control, READY);
	// A solve that gave up before this thread started has already said exit.
	if (Atomics.load(control, COMMAND) === EXIT) return;

	for (;;) {
		Atomics.wait(control, GENERATION, generation);
		generation = Atomics.load(control, GENERATION);
		if (Atomics.load(control, COMMAND) === EXIT) return;
		const mode = Atomics.load(control, MODE);
		const traverser = Atomics.load(control, TRAVERSER);
		const positive = settings[0];
		const negative = settings[1];
		const sum = settings[2];
		const weight = settings[3];
		const clamp = settings[4];
		try {
			// Off for a current-profile read, which updates nothing.
			engine.setPhase(0, settings[5]);
			if (needsIteration) engine.setIteration(settings[6], settings[7]);
			for (let entry = 0; entry < entries; entry++) {
				const slot = reach + entry * 2 * rowBytes;
				const out = engine.runChance(
					mode, traverser, setup.entryNodes[entry], slot, slot + rowBytes, positive, negative, sum, weight, clamp,
				) >>> 0; // a usize, signed on its way out; see `EngineExports`
				partials.set(new Float32Array(memory.buffer, out, setup.stride), entry * setup.stride);
			}
		} catch (error) {
			// The main thread is blocked in Atomics.wait and cannot see this
			// thread's error event, so say so in shared memory (and count as
			// done, below). Then let the thread die: its engine is not to be trusted.
			Atomics.store(control, FAILED, 1);
			throw error;
		} finally {
			Atomics.add(control, DONE, 1);
			Atomics.notify(control, DONE);
		}
	}
}
