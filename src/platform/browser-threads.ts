/**
 * The browser build's engine threads: started ahead of time, borrowed by solves.
 *
 * Purpose: everything behind `enableThreads` (`poker-flopsolve/threads`), kept
 * out of `platform/browser.ts` so the main browser build carries none of it.
 * See that file for why the threads must be started before a solve.
 */

import type { EngineWorkerSetup } from '../engine.ts';
import { ENGINE_CONTROL } from '../engine.ts';
import { serveEngine } from '../engine-thread.ts';

/** A spawned solver thread. */
interface WorkerHandle {
	terminate(): void;
}

/** The parts of the Web Worker API used here, typed locally: the project builds without DOM typings. */
interface WebWorker {
	postMessage(message: unknown, transfer?: unknown[]): void;
	terminate(): void;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: { message?: string; preventDefault?(): void }) => void) | null;
}

interface MessagePortLike {
	postMessage(message: unknown): void;
}

interface BrowserGlobals {
	Worker?: new (url: string) => WebWorker;
	MessageChannel?: new () => { port1: MessagePortLike; port2: unknown };
	Blob?: new (parts: string[], options: { type: string }) => object;
	URL: { createObjectURL(blob: object): string; revokeObjectURL(url: string): void };
	crossOriginIsolated?: boolean;
	navigator?: { hardwareConcurrency?: number };
	WebAssembly?: { Memory: new (descriptor: { initial: number; maximum: number; shared: boolean }) => object };
}

/** One pre-started engine thread. */
interface Thread {
	readonly worker: WebWorker;
	/**
	 * Where its solves are posted. A message posted on the Worker object
	 * itself does not reach a running child while the parent is blocked in
	 * `Atomics.wait` (Chromium), and a solve blocks right after posting; a
	 * transferred MessagePort delivers regardless.
	 */
	readonly port: MessagePortLike;
	busy: boolean;
}

/** Where the pool is published on `globalThis`. */
export const THREADS_KEY = Symbol.for('poker-flopsolve.browser-threads');

/** What the main build sees of the pool. */
export interface ThreadProvider {
	idle(): number;
	total(): number;
	spawn(setup: EngineWorkerSetup, onError: (error: Error) => void): WorkerHandle;
}

type Holder = Record<symbol, (ThreadProvider & { threads: Thread[] }) | undefined>;

/** The engine threads started so far, shared by every copy of this module. */
function pool(): Thread[] {
	const holder = globalThis as unknown as Holder;
	holder[THREADS_KEY] ??= {
		threads: [],
		idle: () => idleThreads(),
		total: () => pool().length,
		spawn: (setup, onError) => spawn(setup, onError),
	};
	return holder[THREADS_KEY]!.threads;
}

function idleThreads(): number {
	return pool().filter((thread) => !thread.busy).length;
}

/** Stop a thread for good and forget it. */
function drop(thread: Thread): void {
	thread.worker.terminate();
	thread.busy = true;
	const threads = pool();
	const at = threads.indexOf(thread);
	if (at >= 0) threads.splice(at, 1);
}

/** `ENGINE_CONTROL.command`'s value that ends a thread's solve. */
const COMMAND_EXIT = 1;

/**
 * Hand one idle engine thread a solve's setup.
 * @param setup what the thread needs to join the solve
 * @param onError called if the thread dies, so the solve can stop waiting on it
 */
function spawn(setup: EngineWorkerSetup, onError: (error: Error) => void): WorkerHandle {
	const thread = pool().find((candidate) => !candidate.busy);
	if (!thread) throw new Error('No idle engine thread; call enableThreads() from poker-flopsolve/threads first');
	thread.busy = true;
	thread.worker.onerror = (event) => {
		event.preventDefault?.();
		drop(thread);
		onError(new Error(`Engine thread failed: ${event.message ?? 'unknown error'}`));
	};
	thread.port.postMessage(setup);
	const control = new Int32Array(setup.control);
	let released = false;
	return {
		terminate() {
			// A run may be closed twice; by then the thread may serve another.
			if (released) return;
			released = true;
			if (!pool().includes(thread)) return;
			// Whether this solve finished or gave up on starting, tell the
			// thread its solve is over: it returns to waiting for the next
			// setup, having started this one or not (serveEngine checks for
			// exit before it first waits). A thread that died is dropped by
			// its error handler instead.
			if (Atomics.load(control, ENGINE_CONTROL.command) !== COMMAND_EXIT) {
				Atomics.store(control, ENGINE_CONTROL.command, COMMAND_EXIT);
				Atomics.add(control, ENGINE_CONTROL.generation, 1);
				Atomics.notify(control, ENGINE_CONTROL.generation);
			}
			thread.busy = false;
			thread.worker.onerror = () => drop(thread);
		},
	};
}

/** Why threads cannot run here, or null if they can. */
export function threadsUnavailableReason(): string | null {
	const g = globalThis as unknown as BrowserGlobals;
	if (typeof g.Worker !== 'function' || typeof g.Blob !== 'function' || typeof g.MessageChannel !== 'function') {
		return 'no Web Workers here';
	}
	if (g.crossOriginIsolated !== true) {
		return 'the page is not cross-origin isolated (serve it with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp)';
	}
	if (typeof SharedArrayBuffer !== 'function') return 'no SharedArrayBuffer here';
	try {
		// Throws where blocking is not allowed: a page's main thread.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1, 0);
	} catch {
		return 'Atomics.wait is not allowed on this thread; solve inside a Web Worker';
	}
	try {
		new g.WebAssembly!.Memory({ initial: 1, maximum: 1, shared: true });
	} catch {
		return 'no shared WebAssembly memory here';
	}
	return null;
}

/** How long a thread may take to start before it is given up on. */
const START_MS = 30_000;

function startThread(url: string): Promise<Thread | null> {
	const g = globalThis as unknown as BrowserGlobals;
	return new Promise((resolve) => {
		let worker: WebWorker;
		try {
			worker = new g.Worker!(url);
		} catch {
			resolve(null);
			return;
		}
		const timer = setTimeout(() => {
			worker.terminate();
			resolve(null);
		}, START_MS);
		const channel = new g.MessageChannel!();
		worker.onmessage = () => {
			clearTimeout(timer);
			worker.onmessage = null;
			worker.onerror = null;
			resolve({ worker, port: channel.port1, busy: false });
		};
		worker.postMessage(null, [channel.port2]);
		worker.onerror = (event) => {
			event.preventDefault?.();
			clearTimeout(timer);
			worker.terminate();
			resolve(null);
		};
	});
}

/**
 * Start engine threads so that solves can use up to `count` threads, this one
 * included, and resolve to how many a solve can use now. Threads already
 * started are kept; idle ones beyond `count` are stopped, so `prepareThreads(1)`
 * stops every thread no open run is holding. Resolves to 1 where threads cannot run; see
 * {@link threadsUnavailableReason}.
 * @param count threads wanted, this one included; defaults to `navigator.hardwareConcurrency`
 */
export function prepareThreads(count?: number): Promise<number> {
	// One call at a time, so two calls in a row cannot both start the missing threads.
	const next = pending.then(() => resize(count));
	pending = next.catch(() => undefined);
	return next;
}

let pending: Promise<unknown> = Promise.resolve();

async function resize(count?: number): Promise<number> {
	const g = globalThis as unknown as BrowserGlobals;
	const wanted = Math.max(1, Math.floor(count ?? g.navigator?.hardwareConcurrency ?? 1));
	const threads = pool();
	for (let i = threads.length - 1; i >= 0 && threads.length > wanted - 1; i--) {
		if (!threads[i].busy) drop(threads[i]);
	}
	const missing = wanted - 1 - threads.length;
	if (missing > 0 && threadsUnavailableReason() === null) {
		// The worker is this module's own loop, as source: there is no file
		// to point a worker at that every bundler would ship.
		const source =
			`const serveEngine = ${serveEngine.toString()};\n` +
			'onmessage = (event) => {\n' +
			'\tevent.ports[0].onmessage = (solve) => serveEngine(solve.data);\n' +
			"\tpostMessage('ready');\n" +
			'};\n';
		const url = g.URL.createObjectURL(new g.Blob!([source], { type: 'text/javascript' }));
		try {
			const started = await Promise.all(Array.from({ length: missing }, () => startThread(url)));
			for (const thread of started) if (thread) threads.push(thread);
		} finally {
			g.URL.revokeObjectURL(url);
		}
	}
	return threadsUnavailableReason() === null ? Math.min(wanted, 1 + idleThreads()) : 1;
}
