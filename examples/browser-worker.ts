/**
 * Solving in the browser, off the page's main thread.
 *
 * A solve blocks whatever thread it runs on, so a page should host it in a Web
 * Worker. Iterations run in chunks, with a yield between them so a `stop`
 * message can land; chunking costs nothing over one long call.
 *
 * Page side:
 *
 *   const worker = new Worker(new URL('./browser-worker.js', import.meta.url), { type: 'module' });
 *   worker.onmessage = ({ data }) => console.log(data);  // progress, then done
 *   worker.postMessage({ type: 'solve', config, iterations: 1000, targetPercent: 0.3 });
 *   // worker.postMessage({ type: 'stop' });
 *
 * The browser build is single-threaded and needs no special page headers. It
 * is meant for river and small turn spots; bigger spots belong in Node.
 */

import { createRun, defineSpot } from '@toysolver/holdem';
import type { SpotConfig } from '@toysolver/holdem';

/** The parts of a worker's global scope this uses; no DOM typings needed. */
declare const self: {
	postMessage(message: unknown): void;
	onmessage: ((event: { data: Request }) => void) | null;
};

type Request =
	| { type: 'solve'; config: SpotConfig; iterations: number; targetPercent?: number }
	| { type: 'stop' };

/** Iterations between progress reports and chances to stop. */
const CHUNK = 10;

let stopping = false;

const yieldToMessages = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function solveSpot(config: SpotConfig, iterations: number, targetPercent: number): Promise<void> {
	const run = createRun(defineSpot(config));
	try {
		let exploitability = Infinity;
		while (run.completed < iterations && !stopping) {
			run.step(Math.min(CHUNK, iterations - run.completed));
			// Each check is a full best-response pass, about one iteration.
			exploitability = run.exploitabilityPercent();
			self.postMessage({ type: 'progress', iterations: run.completed, exploitability });
			if (exploitability <= targetPercent) break;
			await yieldToMessages();
		}
		const solution = run.snapshot();
		self.postMessage({
			type: 'done',
			iterations: solution.iterations,
			exploitability,
			ev: [solution.ev(0), solution.ev(1)],
			// A Solution cannot cross to the page, but what it returns can:
			// typed arrays are copied by postMessage.
			root: solution.strategyAt(0, 0),
		});
	} finally {
		run.close();
	}
}

self.onmessage = ({ data }) => {
	if (data.type === 'stop') {
		stopping = true;
		return;
	}
	stopping = false;
	solveSpot(data.config, data.iterations, data.targetPercent ?? 0).catch((error: unknown) =>
		self.postMessage({ type: 'error', message: String(error) }),
	);
};
