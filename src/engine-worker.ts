/**
 * An engine worker: one thread of a WebAssembly solve.
 *
 * Purpose: walk this thread's slice of the runouts at the split round, over
 * the memory every thread shares, when the main thread signals. The protocol
 * is src/parallel.ts's: the main thread collects the reach each entry needs,
 * every thread walks its slice from each entry, the main thread adds the
 * slices up and finishes. Here all of it happens in shared WebAssembly
 * memory, so nothing is copied between threads but a few numbers of control.
 */

import { parentPort, workerData } from 'node:worker_threads';
import type { EngineExports, EngineWorkerSetup } from './engine.ts';
import { ENGINE_CONTROL } from './engine.ts';

const setup = workerData as EngineWorkerSetup;
const { WebAssembly: wasm } = globalThis as unknown as {
	WebAssembly: { Instance: new (module: unknown, imports: object) => { exports: Record<string, unknown> } };
};
const memory = setup.memory as { buffer: SharedArrayBuffer };
const instance = new wasm.Instance(setup.module, { env: { memory, abort: () => { throw new Error('engine abort'); } } });
const engine = instance.exports as unknown as EngineExports;
engine.init(setup.header);
engine.setMaxActions(setup.maxActions);
engine.setExchange(...setup.exchange);
engine.setShard(...setup.shard);
engine.setPhase(0, 1);

const control = new Int32Array(setup.control);
const settings = new Float64Array(setup.settings);
const entries = setup.entryNodes.length;
const rowBytes = setup.stride * 4;
const partials = new Float32Array(memory.buffer, setup.partial, entries * setup.stride);
const [, reach] = setup.exchange;

// Latch the generation before announcing readiness, so no dispatch is missed.
let generation = Atomics.load(control, ENGINE_CONTROL.generation);
Atomics.add(control, ENGINE_CONTROL.ready, 1);
Atomics.notify(control, ENGINE_CONTROL.ready);

for (;;) {
	Atomics.wait(control, ENGINE_CONTROL.generation, generation);
	generation = Atomics.load(control, ENGINE_CONTROL.generation);
	if (Atomics.load(control, ENGINE_CONTROL.command) === 1) break;
	const mode = Atomics.load(control, ENGINE_CONTROL.mode);
	const traverser = Atomics.load(control, ENGINE_CONTROL.traverser);
	const [positive, negative, sum, weight, clamp] = settings;
	for (let entry = 0; entry < entries; entry++) {
		const slot = reach + entry * 2 * rowBytes;
		const out = engine.runChance(
			mode, traverser, setup.entryNodes[entry], slot, slot + rowBytes, positive, negative, sum, weight, clamp,
		);
		partials.set(new Float32Array(memory.buffer, out, setup.stride), entry * setup.stride);
	}
	Atomics.add(control, ENGINE_CONTROL.done, 1);
	Atomics.notify(control, ENGINE_CONTROL.done);
}

parentPort?.close();
