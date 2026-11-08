/**
 * Compact storage in headless Chromium, one thread (the JavaScript engine has
 * no browser threads): seconds per iteration beside 16-bit storage and the
 * 32-bit WebAssembly engine, on a spot that fits all three, and whether the
 * target spot T's compact storage allocates and runs in a tab at all.
 *
 *   node --import tsx bench/storage/browser.ts [spot] [iterations] [--t]
 */

import { runInBrowser } from '../../scripts/browser-harness.ts';
import { STORAGE_SPOTS } from './spots.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const name = args[0] ?? 'T0mono';
const iterations = Number(args[1] ?? 3);
const withT = process.argv.includes('--t');
const variants: [string, unknown, unknown][] = [
	['f32 wasm', null, {}],
	['i16', null, { precision: 'i16' }],
	['compact', {}, {}],
	['compact, sums: false, blockScale, cfr+', { sums: false, blockScale: true }, { algorithm: 'cfr+' }],
];
const jobs = variants.map(([label, storage, options]) => ({ label, spot: name, storage, options }));
if (withT) jobs.push({ label: 'T compact, sums: false, blockScale, cfr+', spot: 'T', storage: { sums: false, blockScale: true }, options: { algorithm: 'cfr+' } });

const result = await runInBrowser<string[]>(
	`
	import { createRun, defineSpot } from './src/index.ts';
	const SPOTS = ${JSON.stringify(STORAGE_SPOTS)};
	const JOBS = ${JSON.stringify(jobs)};
	export default async function run() {
		const out = [];
		for (const job of JOBS) {
			try {
				const t0 = performance.now();
				const config = { ...SPOTS[job.spot], ...(job.storage ? { compactStorage: job.storage } : {}) };
				const spot = defineSpot(config);
				const run = createRun(spot, { workers: 1, ...job.options });
				const setup = (performance.now() - t0) / 1000;
				run.step(1);
				const t1 = performance.now();
				run.step(${iterations});
				const per = (performance.now() - t1) / 1000 / ${iterations};
				const bytes = run.solver.ctx.layout.bytes;
				run.close();
				out.push(job.label + ' on ' + job.spot + ': ' + run.engine + ', ' + (bytes / 2 ** 30).toFixed(2) + ' GiB storage, setup ' + setup.toFixed(1) + ' s, ' + per.toFixed(2) + ' s/iteration');
			} catch (e) {
				out.push(job.label + ' on ' + job.spot + ': ' + e);
			}
		}
		return out;
	}
	`,
	3_600_000,
);
console.log(result.join('\n'));
