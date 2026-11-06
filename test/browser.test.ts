/**
 * The browser build, run in a real browser.
 *
 * Bundled the way `tsup` bundles `dist/browser.js` and run in a Web Worker in
 * headless Chromium, the small spots the browser is meant for must give the
 * same answer as Node. Skipped where no Playwright Chromium is installed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { defineSpot, PLATFORM, solve } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { bundleForBrowser, NoBrowserError, runInBrowser } from '../scripts/browser-harness.ts';

/** River presets from the UI, and a small turn spot. */
const SPOTS: Record<string, { config: SpotConfig; iterations: number }> = {
	'river polarised': {
		config: { board: '2c 7d 9h Js 3c', pot: 100, stack: 75, oop: 'JJ,54s', ip: 'TT', betSizes: [[0.75]], maxRaises: 1 },
		iterations: 300,
	},
	'river wide': {
		config: {
			board: 'As Kh 7d 2c 9s', pot: 80, stack: 100,
			oop: '22+,A2s+,KTs+,AJo+', ip: '22+,A8s+,KJs+,ATo+',
			betSizes: [[0.33, 0.75]], maxRaises: 1,
		},
		iterations: 150,
	},
	'turn narrow': {
		config: {
			board: 'As Kh 7d 2c', pot: 60, stack: 100,
			oop: 'AA,KK,77,AKs,AQs,KQs,65s', ip: 'QQ,JJ,AJs,KJs,QJs,JTs,T9s',
			betSizes: [[0.66]], maxRaises: 1,
		},
		iterations: 60,
	},
};

interface Outcome {
	platform: string;
	workers: number;
	ev: [number, number];
	exploitability: number;
}

function solveHere(config: SpotConfig, iterations: number): Outcome {
	const solution = solve(defineSpot(config), { iterations });
	return {
		platform: PLATFORM,
		workers: solution.workers,
		ev: [solution.ev(0), solution.ev(1)],
		exploitability: solution.exploitabilityPercent(),
	};
}

let browser: (Record<string, Outcome> & { simd?: boolean }) | null = null;

beforeAll(async () => {
	// One browser launch for every spot. Asking for 4 workers checks that the
	// browser build falls back to one thread instead of failing.
	const source = `
		import { defineSpot, PLATFORM, simdAvailable, solve } from './src/index.ts';
		const SPOTS = ${JSON.stringify(SPOTS)};
		export default async function run() {
			const out = { simd: simdAvailable() };
			for (const [name, { config, iterations }] of Object.entries(SPOTS)) {
				const solution = solve(defineSpot(config), { iterations, workers: 4 });
				out[name] = {
					platform: PLATFORM,
					workers: solution.workers,
					ev: [solution.ev(0), solution.ev(1)],
					exploitability: solution.exploitabilityPercent(),
				};
			}
			return out;
		}
	`;
	try {
		browser = await runInBrowser<Record<string, Outcome>>(source);
	} catch (error) {
		if (!(error instanceof NoBrowserError)) throw error;
		console.warn(`Skipping browser checks: ${error.message}`);
	}
}, 180_000);

describe('browser build', () => {
	it('bundles without any Node import', async () => {
		// esbuild fails the build on a `node:` import under platform 'browser'.
		const bundle = await bundleForBrowser(`export { solve } from './src/index.ts'; export default async () => 0;`);
		expect(bundle).not.toMatch(/from ["']node:/);
		expect(bundle).not.toMatch(/worker_threads/);
	});

	it('runs the WebAssembly SIMD kernels', (context) => {
		if (!browser) {
			context.skip();
			return;
		}
		expect(browser.simd).toBe(true);
	});

	for (const [name, { config, iterations }] of Object.entries(SPOTS)) {
		it(`solves the ${name} spot as Node does`, (context) => {
			if (!browser) {
				context.skip();
				return;
			}
			const here = solveHere(config, iterations);
			const there = browser[name] as Outcome;
			expect(there.platform).toBe('browser');
			expect(there.workers).toBe(1);
			// Same code on the same engine family; allow for a last-bit
			// difference in Math.pow between V8 versions.
			expect(there.ev[0]).toBeCloseTo(here.ev[0], 9);
			expect(there.ev[1]).toBeCloseTo(here.ev[1], 9);
			expect(there.exploitability).toBeCloseTo(here.exploitability, 9);
		});
	}
});
