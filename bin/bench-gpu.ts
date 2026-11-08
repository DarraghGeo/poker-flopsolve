/**
 * WebGPU river-kernel benchmark (issue #39).
 *
 * Purpose: decide whether a WebGPU kernel for the river showdown and regret
 * matching is worth integrating. On the flop spots of #29, it times the
 * engine's WebAssembly SIMD kernels against the WebGPU prototype
 * (bench/gpu) over the batch one training iteration hands them, with and
 * without the upload and readback a CPU solver would pay. It checks they
 * agree, and projects the time to 0.3% of the pot against the 4-thread
 * browser baseline.
 *
 *   npm run bench:gpu                         # Playwright's Chromium, WebGPU flags on
 *   npm run bench:gpu -- --spots flop --reps 9
 *   npm run bench:gpu -- --channel chrome     # an installed Chrome instead
 *   npm run bench:gpu -- --headed             # a visible window (some GPUs need it)
 *   npm run bench:gpu -- --serve              # print a URL to open in any browser
 *   npm run bench:gpu -- --software           # SwiftShader: correctness only
 *
 * Timings need a real GPU. On a software adapter the bench still checks
 * agreement, but it labels every GPU number as meaningless.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SpotConfig } from '../src/index.ts';
import { SPOTS as COMPARE } from '../bench/compare/spots.ts';
import { compileBenchWasm } from '../bench/gpu/compile.ts';
import type { ExperimentResult } from '../bench/gpu/experiment.ts';
import { ARCHETYPES } from '../bench/leaf/lib.ts';
import { bundleForBrowser, runInBrowser } from '../scripts/browser-harness.ts';

const OOP = ARCHETYPES.benchOop;
const IP = ARCHETYPES.benchIp;

/** The spots of #29, with its measured browser times to 0.3% of pot: 1 thread, 4 threads. */
const ALL: Record<string, { config: SpotConfig; baseline: [number, number] }> = {
	flop: { config: COMPARE.flop, baseline: [24.2, 8.3] },
	monotone: { config: COMPARE.monotone, baseline: [8.3, 2.9] },
	wide: { config: { board: 'AsKh7d', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.66]], maxRaises: 1 }, baseline: [14.2, 5.1] },
};

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : undefined;
};
const names = (option('spots') ?? Object.keys(ALL).join(',')).split(',');
for (const name of names) if (!ALL[name]) throw new Error(`unknown spot ${name}; try ${Object.keys(ALL).join(', ')}`);
const count = (name: string, fallback: number): number => {
	const value = Number(option(name) ?? fallback);
	if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} takes a whole number from 1`);
	return value;
};
const reps = count('reps', 5);
const iterations = count('iters', 4);
/** How long a browser gets to finish, in ms. */
const TIMEOUT_MS = 1_800_000;

const wasm = Buffer.from(compileBenchWasm()).toString('base64');
const spots = names.map((name) => ({ name, config: ALL[name].config }));

const ENTRY = `
import experiment from './bench/gpu/experiment.ts';
const SPOTS = ${JSON.stringify(spots)};
const WASM = ${JSON.stringify(wasm)};
export default async function run() {
	const out = {};
	for (const { name, config } of SPOTS) {
		out[name] = await experiment({ config, wasm: WASM, reps: ${reps}, iterations: ${iterations} });
	}
	return out;
}
`;

let results: Record<string, ExperimentResult>;
if (args.includes('--serve')) {
	results = await serve();
} else {
	const flags = ['--enable-unsafe-webgpu'];
	if (process.platform === 'linux') flags.push('--enable-features=Vulkan');
	if (args.includes('--software')) flags.push('--use-angle=swiftshader');
	const launch: Record<string, unknown> = { args: flags, headless: !args.includes('--headed') };
	const channel = option('channel');
	if (channel) launch.channel = channel;
	results = await runInBrowser<Record<string, ExperimentResult>>(ENTRY, TIMEOUT_MS, { launch });
}
report(results);

/** Serve the bench as a page, wait for a browser to open it and post its results back. */
async function serve(): Promise<Record<string, ExperimentResult>> {
	const entry = await bundleForBrowser(ENTRY);
	const page = `<!doctype html><meta charset="utf-8"><title>poker-flopsolve GPU bench</title>
<pre id="out">Running; this takes a few minutes. Keep the tab in front.</pre>
<script type="module">
const worker = new Worker('./worker.js', { type: 'module' });
const send = async (data) => {
	document.getElementById('out').textContent = JSON.stringify(data, null, 2);
	await fetch('./result', { method: 'POST', body: JSON.stringify(data) });
};
worker.onmessage = (event) => send(event.data);
worker.onerror = (event) => send({ ok: false, error: event.message || 'worker failed to load' });
</script>`;
	const shim = `import run from './entry.js';
run().then((value) => postMessage({ ok: true, value }), (error) => postMessage({ ok: false, error: String(error && error.stack || error) }));`;
	const files: Record<string, [string, string]> = {
		'/': ['text/html', page],
		'/worker.js': ['text/javascript', shim],
		'/entry.js': ['text/javascript', entry],
	};
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			server.close();
			reject(new Error(`no result from a browser within ${TIMEOUT_MS / 60000} minutes`));
		}, TIMEOUT_MS);
		const server = createServer((request, response) => {
			if (request.method === 'POST' && request.url === '/result') {
				let body = '';
				request.on('data', (chunk) => (body += chunk));
				request.on('end', () => {
					response.writeHead(204).end();
					clearTimeout(timer);
					server.close();
					const message = JSON.parse(body) as { ok: boolean; value?: Record<string, ExperimentResult>; error?: string };
					if (message.ok) resolve(message.value!);
					else reject(new Error(`In the browser: ${message.error}`));
				});
				return;
			}
			const file = files[request.url ?? '/'];
			if (!file) return void response.writeHead(404).end();
			response.writeHead(200, { 'content-type': file[0] }).end(file[1]);
		});
		const port = Number(option('port') ?? 8787);
		server.listen(port, '127.0.0.1', () => {
			const { port: bound } = server.address() as AddressInfo;
			console.log(`Open http://127.0.0.1:${bound}/ in a browser with WebGPU (Chrome or Edge 113+).`);
		});
	});
}

/** Columns, right-aligned after the first. */
function table(rows: string[][]): void {
	const widths = rows[0].map((_, c) => Math.max(...rows.map((row) => row[c].length)));
	for (const row of rows) console.log(row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join('   '));
}

function report(all: Record<string, ExperimentResult>): void {
	const first = Object.values(all)[0];
	console.log(`adapter: ${first.adapter ?? 'none (no WebGPU adapter)'}`);
	if (!first.adapter) console.log('No adapter: try --channel chrome, --headed or --serve. Only the CPU side was timed.');
	else if (first.software) console.log('SOFTWARE ADAPTER: the GPU columns are CPU emulation and mean nothing. Agreement is still checked.');
	const ms = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '-');
	const times = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(2)}x` : '-');
	// Through --serve, JSON turns NaN and Infinity into null: both mean a broken value.
	const error = (v: number | null): string => (typeof v === 'number' && Number.isFinite(v) ? v.toExponential(1) : 'BROKEN');

	console.log('\nOne training iteration (both traversers): its river batch, and times in ms. "trip" adds upload and readback.\n');
	const sizes = [['spot', 'showdowns', 'hands', 'MB up+down', 'match blocks', 'match slots', 'error sd', 'error match']];
	const timing = [['spot', 'iteration', 'sd wasm', 'sd gpu', 'sd trip', 'match wasm', 'match gpu', 'match trip', 'river share']];
	for (const name of names) {
		const r = all[name];
		const sd = r.showdown!;
		const rm = r.match!;
		sizes.push([
			name, String(r.jobs), String(r.hands), (r.showdownBytes / 2 ** 20).toFixed(0), String(r.blocks), String(r.slots),
			error(r.showdownError), error(r.matchError),
		]);
		timing.push([
			name, ms(r.iterationMs), ms(sd.cpu), ms(sd.gpuKernel), ms(sd.gpuRoundTrip), ms(rm.cpu), ms(rm.gpuKernel), ms(rm.gpuRoundTrip),
			`${(((sd.cpu + rm.cpu) / r.iterationMs) * 100).toFixed(0)}%`,
		]);
	}
	table(sizes);
	console.log('');
	table(timing);

	console.log(
		'\nKernel speed-ups over WebAssembly, and the time to 0.3% of pot projected from #29\'s one-thread time with the\n' +
			'river kernels\' share swapped for the GPU\'s: "free" if the GPU took no time at all. In seconds, against #29\'s 4 threads.\n',
	);
	const projected = [['spot', 'sd gpu', 'sd trip', 'match gpu', 'match trip', 'with gpu', 'with trip', 'gpu free', '1 thread', '4 threads']];
	for (const name of names) {
		const r = all[name];
		const sd = r.showdown!;
		const rm = r.match!;
		const [one, four] = ALL[name].baseline;
		const project = (gpu: number): number => (one * Math.max(0, r.iterationMs - sd.cpu - rm.cpu + gpu)) / r.iterationMs;
		projected.push([
			name, times(sd.cpu / sd.gpuKernel), times(sd.cpu / sd.gpuRoundTrip), times(rm.cpu / rm.gpuKernel), times(rm.cpu / rm.gpuRoundTrip),
			ms(project(sd.gpuKernel + rm.gpuKernel)), ms(project(sd.gpuRoundTrip + rm.gpuRoundTrip)), ms(project(0)), String(one), String(four),
		]);
	}
	table(projected);
	console.log(
		'\nThe projection is a ceiling: it assumes the GPU work replaces the CPU work in place, which the synchronous\n' +
			'engine cannot do as it stands (#39, "What doesn\'t apply"), and that the rest of the iteration stays on one thread.',
	);
}
