/**
 * Opt-in threads in the browser build (`poker-flopsolve/threads`).
 *
 * In headless Chromium, on a cross-origin isolated page, a threaded solve must
 * be deterministic and give what Node gives at the same thread count; on a
 * page that is not isolated, asking for threads must fall back to one. Without
 * the opt-in, the main browser bundle must carry none of the thread pool.
 * The browser checks are skipped where no Playwright Chromium is installed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { ENGINE_CONTROL } from '../src/engine.ts';
import { serveEngine } from '../src/engine-thread.ts';
import { enableThreads, threadsUnavailable } from '../src/threads.ts';
import { bundleForBrowser, NoBrowserError, runInBrowser } from '../scripts/browser-harness.ts';

const SPOTS: Record<string, { config: SpotConfig; iterations: number }> = {
	'turn narrow': {
		config: {
			board: 'As Kh 7d 2c', pot: 60, stack: 100,
			oop: 'AA,KK,77,AKs,AQs,KQs,65s', ip: 'QQ,JJ,AJs,KJs,QJs,JTs,T9s',
			betSizes: [[0.66]], maxRaises: 1,
		},
		iterations: 60,
	},
	'two-tone flop': {
		config: {
			board: 'Ts 9s 4h', pot: 60, stack: 100,
			oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
			betSizes: [[0.66]], maxRaises: 1,
		},
		iterations: 30,
	},
};

const THREADS = 3;

interface Outcome {
	workers: number;
	ev: [number, number];
	exploitability: number;
	root: number[];
}

/** The same solve in Node and in the browser. */
const SOLVE = `
function solveSpot(createRun, defineSpot, config, iterations, workers) {
	const run = createRun(defineSpot(config), { workers });
	try {
		run.step(iterations);
		const solution = run.snapshot();
		return {
			workers: run.workers,
			ev: [solution.ev(0), solution.ev(1)],
			exploitability: run.exploitabilityPercent(),
			root: Array.from(solution.strategyAt(solution.spot.tree.decisionNodes[0], 0).probs),
		};
	} finally {
		run.close();
	}
}
`;

const solveSpot = new Function(`${SOLVE}; return solveSpot;`)() as (
	create: typeof createRun,
	define: typeof defineSpot,
	config: SpotConfig,
	iterations: number,
	workers: number,
) => Outcome;

interface Isolated {
	reason: string | null;
	threads: number;
	again: number;
	released: number;
	whileHeld: number;
	afterDoubleClose: number[];
	afterFailedCreate: number;
	solves: Record<string, { one: Outcome; first: Outcome; second: Outcome }>;
}

interface NotIsolated {
	reason: string | null;
	threads: number;
	outcome: Outcome;
}

let isolated: Isolated | null = null;
let notIsolated: NotIsolated | null = null;

beforeAll(async () => {
	const prelude = `
		import { createRun, defineSpot } from './src/index.ts';
		import { enableThreads, threadsUnavailable } from './src/threads.ts';
		${SOLVE}
		const SPOTS = ${JSON.stringify(SPOTS)};
	`;
	try {
		isolated = await runInBrowser<Isolated>(
			`${prelude}
			export default async function run() {
				const reason = threadsUnavailable();
				const threads = await enableThreads(${THREADS});
				const solves = {};
				for (const [name, { config, iterations }] of Object.entries(SPOTS)) {
					solves[name] = {
						one: solveSpot(createRun, defineSpot, config, iterations, 1),
						first: solveSpot(createRun, defineSpot, config, iterations, ${THREADS}),
						// The same threads again, after the first solve gave them back.
						second: solveSpot(createRun, defineSpot, config, iterations, ${THREADS}),
					};
				}
				const again = await enableThreads(${THREADS});
				const [name] = Object.keys(SPOTS);
				const { config } = SPOTS[name];

				// While a run holds the threads, a new solve can use only this one.
				const held = createRun(defineSpot(config), { workers: ${THREADS} });
				const whileHeld = await enableThreads(${THREADS});
				held.close();

				// Closing a run twice must not free threads another run is using.
				const first = createRun(defineSpot(config), { workers: ${THREADS} });
				first.close();
				const second = createRun(defineSpot(config), { workers: ${THREADS} });
				first.close();
				const third = createRun(defineSpot(config), { workers: ${THREADS} });
				const afterDoubleClose = [second.workers, third.workers];
				third.close();
				second.step(2);
				second.close();

				// A run that fails after borrowing threads gives them back.
				const other = createRun(defineSpot({ ...config, board: 'Qs Jh 3d 2c' }), { workers: 1 });
				other.step(1);
				try {
					createRun(defineSpot(config), { workers: ${THREADS}, warmStart: other });
				} catch {}
				other.close();
				const afterFailedCreate = await enableThreads(${THREADS});

				const released = await enableThreads(1);
				return { reason, threads, again, released, whileHeld, afterDoubleClose, afterFailedCreate, solves };
			}`,
			180_000,
			{ isolated: true },
		);
		notIsolated = await runInBrowser<NotIsolated>(
			`${prelude}
			export default async function run() {
				const reason = threadsUnavailable();
				const threads = await enableThreads(${THREADS});
				const [name] = Object.keys(SPOTS);
				const { config, iterations } = SPOTS[name];
				return { reason, threads, outcome: solveSpot(createRun, defineSpot, config, iterations, ${THREADS}) };
			}`,
		);
	} catch (error) {
		if (!(error instanceof NoBrowserError)) throw error;
		console.warn(`Skipping browser thread checks: ${error.message}`);
	}
}, 300_000);

describe('engine thread loop', () => {
	it('inlines the control slots ENGINE_CONTROL defines', () => {
		const source = serveEngine.toString();
		const slot = (name: string): number => Number(new RegExp(`const ${name} = (\\d+)`).exec(source)?.[1]);
		expect(slot('GENERATION')).toBe(ENGINE_CONTROL.generation);
		expect(slot('DONE')).toBe(ENGINE_CONTROL.done);
		expect(slot('COMMAND')).toBe(ENGINE_CONTROL.command);
		expect(slot('MODE')).toBe(ENGINE_CONTROL.mode);
		expect(slot('TRAVERSER')).toBe(ENGINE_CONTROL.traverser);
		expect(slot('READY')).toBe(ENGINE_CONTROL.ready);
	});

	it('stands alone, so it can ship as worker source', () => {
		// Compiled with nothing in scope but globals, it must still parse and
		// name nothing it does not define.
		const fn = new Function(`return (${serveEngine.toString()});`)() as unknown;
		expect(typeof fn).toBe('function');
		expect(serveEngine.toString()).not.toMatch(/__name|require\(|import\(/);
	});
});

describe('threads entry in Node', () => {
	it('needs no preparation', async () => {
		expect(threadsUnavailable()).toBeNull();
		await expect(enableThreads(3)).resolves.toBe(3);
	});
});

describe('browser build threads', () => {
	it('leaves the thread pool out of the main bundle', async () => {
		const bundle = await bundleForBrowser(`export * from './src/index.ts'; export default async () => 0;`);
		expect(bundle).not.toMatch(/serveEngine|MessageChannel|createObjectURL/);
		const threads = await bundleForBrowser(`export * from './src/threads.ts'; export default async () => 0;`);
		expect(threads).toMatch(/serveEngine/);
	});

	it('starts threads on a cross-origin isolated page, and releases them', (context) => {
		if (!isolated) {
			context.skip();
			return;
		}
		expect(isolated.reason).toBeNull();
		expect(isolated.threads).toBe(THREADS);
		expect(isolated.again).toBe(THREADS);
		expect(isolated.released).toBe(1);
	});

	it('lends each thread to one open run at a time', (context) => {
		if (!isolated) {
			context.skip();
			return;
		}
		expect(isolated.whileHeld).toBe(1);
		expect(isolated.afterDoubleClose).toEqual([THREADS, 1]);
		expect(isolated.afterFailedCreate).toBe(THREADS);
	});

	it('falls back to one thread on a page that is not isolated', (context) => {
		if (!notIsolated) {
			context.skip();
			return;
		}
		expect(notIsolated.reason).toMatch(/cross-origin isolated/);
		expect(notIsolated.threads).toBe(1);
		expect(notIsolated.outcome.workers).toBe(1);
	});

	for (const [name, { config, iterations }] of Object.entries(SPOTS)) {
		it(`solves the ${name} on ${THREADS} threads, deterministically and as Node does`, (context) => {
			if (!isolated) {
				context.skip();
				return;
			}
			const { one, first, second } = isolated.solves[name];
			expect(first.workers).toBe(THREADS);
			expect(second).toEqual(first);

			for (const [there, workers] of [[one, 1], [first, THREADS]] as const) {
				const here = solveSpot(createRun, defineSpot, config, iterations, workers);
				expect(here.workers).toBe(workers);
				// Same engine, same split; allow for a last-bit difference in
				// Math.pow between V8 versions, as the single-threaded check does.
				expect(there.ev[0]).toBeCloseTo(here.ev[0], 9);
				expect(there.ev[1]).toBeCloseTo(here.ev[1], 9);
				expect(there.exploitability).toBeCloseTo(here.exploitability, 9);
				for (let i = 0; i < here.root.length; i++) expect(there.root[i]).toBeCloseTo(here.root[i], 9);
			}
		});
	}
});
