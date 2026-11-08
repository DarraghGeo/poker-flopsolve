/**
 * Out-of-core river storage in a real browser (`poker-flopsolve/out-of-core`):
 * in a Web Worker in headless Chromium, the river paged through an Origin
 * Private File System file with a sync access handle solves a flop spot to
 * the same answer, bit for bit at 32 bits, as storage in memory there. Also
 * checks the entry bundles for the browser without any Node import. Skipped
 * where no Playwright Chromium is installed.
 */

import { describe, expect, it } from 'vitest';
import type { SpotConfig } from '../src/index.ts';
import { bundleForBrowser, NoBrowserError, runInBrowser } from '../scripts/browser-harness.ts';

const flop: SpotConfig = {
	board: 'Ks 9s 4s', pot: 60, stack: 100,
	oop: 'AA,KK,77,AKs,AQs,KQs,QJs,T9s', ip: 'QQ,JJ,TT,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};

interface Outcome {
	exploitability: number;
	ev: [number, number];
}

describe('out-of-core in a browser', () => {
	it('bundles without any Node import', async () => {
		const bundle = await bundleForBrowser(
			`export { outOfCore } from './src/out-of-core.ts'; export default async () => 0;`,
		);
		expect(bundle).not.toMatch(/from ["']node:/);
	});

	it('pages the river through OPFS to the in-memory answer', async (context) => {
		const source = `
			import { createRun, defineSpot } from './src/index.ts';
			import { outOfCore } from './src/out-of-core.ts';
			const outcome = (run) => {
				run.step(8);
				const snapshot = run.snapshot();
				const result = { exploitability: run.exploitabilityPercent(), ev: [snapshot.ev(0), snapshot.ev(1)] };
				run.close();
				return result;
			};
			export default async function run() {
				const spot = defineSpot(${JSON.stringify(flop)});
				const memory = outcome(createRun(spot, { precision: 'f32', engine: 'js' }));
				const root = await navigator.storage.getDirectory();
				const handle = await (await root.getFileHandle('river.bin', { create: true })).createSyncAccessHandle();
				try {
					const run = createRun(spot, { precision: 'f32', outOfCore: outOfCore(handle) });
					const fileBytes = run.outOfCore().fileBytes;
					return { memory, paged: outcome(run), fileBytes, size: handle.getSize() };
				} finally {
					handle.close();
					await root.removeEntry('river.bin');
				}
			}
		`;
		let result: { memory: Outcome; paged: Outcome; fileBytes: number; size: number };
		try {
			result = await runInBrowser(source, 180_000);
		} catch (error) {
			if (!(error instanceof NoBrowserError)) throw error;
			context.skip();
			return;
		}
		expect(result.size).toBe(result.fileBytes);
		expect(result.fileBytes).toBeGreaterThan(0);
		expect(result.paged.exploitability).toBe(result.memory.exploitability);
		expect(result.paged.ev).toEqual(result.memory.ev);
	}, 240_000);
});
