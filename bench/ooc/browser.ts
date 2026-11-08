/**
 * Issue #55: an out-of-core solve in headless Chromium, river paged through
 * an OPFS file with a sync access handle, inside a Web Worker on a
 * persistent profile (so OPFS is on disk, as in a normal tab).
 *
 *   node --import tsx bench/ooc/browser.ts [spot] [iterations] [--memory]
 *
 * spot: Tmono (T on Ks9s4s), T0 (AsKh7d), T (AsKh7d), or small. Prints ms per
 * iteration, I/O time and bytes, resident storage, the JS heap, and the
 * browser's storage quota.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { bundleForBrowser } from '../../scripts/browser-harness.ts';
import { T } from './size.ts';

const which = process.argv[2] ?? 'small';
const iterations = Number(process.argv[3] ?? 2);
// In memory instead, at 16 bits, for comparison.
const inMemory = process.argv.includes('--memory');
const GiB = 2 ** 30;
const configs = {
	small: { board: 'As Kh 7d', pot: 60, stack: 100, oop: 'AA,KK,77,AKs,AQs,KQs,QJs,T9s', ip: 'QQ,JJ,TT,AJs,KJs,QJs,JTs,T9s', betSizes: [[0.5, 1]], maxRaises: 2 },
	Tmono: T('Ks 9s 4s'),
	T0: T('As Kh 7d', { raiseSizes: ['allin'], maxRaises: 2 }),
	T: T('As Kh 7d'),
};
const config = { ...(configs as Record<string, object>)[which], maxBytes: 64 * GiB };

const source = `
import { createRun, defineSpot } from './src/index.ts';
import { outOfCore } from './src/out-of-core.ts';
export default async function run() {
	const quota = await navigator.storage.estimate();
	const root = await navigator.storage.getDirectory();
	const handle = await (await root.getFileHandle('river.bin', { create: true })).createSyncAccessHandle();
	try {
		const spot = defineSpot(${JSON.stringify(config)});
		let t = performance.now();
		const run = createRun(spot, ${inMemory} ? { precision: 'i16' } : { outOfCore: outOfCore(handle) });
		const none = { ioMs: 0, bytesRead: 0, bytesWritten: 0, residentBytes: spot.estimate.compressedBytes, fileBytes: 0 };
		const setupMs = performance.now() - t;
		const times = [];
		const io = [];
		for (let i = 0; i < ${iterations}; i++) {
			const before = (run.outOfCore() ?? none).ioMs;
			t = performance.now();
			run.step(1);
			times.push(Math.round(performance.now() - t));
			io.push(Math.round((run.outOfCore() ?? none).ioMs - before));
		}
		const report = run.outOfCore() ?? none;
		const during = await navigator.storage.estimate();
		run.close();
		return { setupMs: Math.round(setupMs), times, io, report, engine: run.engine,
			quota: quota.quota, usage: during.usage, slots: spot.estimate.totalSlots,
			heap: globalThis.performance?.memory?.usedJSHeapSize ?? null };
	} finally {
		handle.close();
		await root.removeEntry('river.bin');
	}
}
`;

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
const worker = new Worker('./worker.js', { type: 'module' });
worker.onmessage = (event) => { window.__result = event.data; };
worker.onerror = (event) => { window.__result = { ok: false, error: event.message || 'worker failed' }; };
</script>`;
const SHIM = `import run from './entry.js';
run().then((value) => postMessage({ ok: true, value }), (e) => postMessage({ ok: false, error: String(e && e.stack || e) }));`;
const entry = await bundleForBrowser(source);
const files: Record<string, [string, string]> = {
	'/': ['text/html', PAGE], '/worker.js': ['text/javascript', SHIM], '/entry.js': ['text/javascript', entry],
};
const server = createServer((req, res) => {
	const f = files[req.url ?? '/'];
	if (!f) return void res.writeHead(404).end();
	res.writeHead(200, { 'content-type': f[0] }).end(f[1]);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address() as AddressInfo;
const { chromium } = createRequire(import.meta.url)('playwright');
const profile = mkdtempSync(join(tmpdir(), 'ooc-'));
const context = await chromium.launchPersistentContext(profile);
try {
	const page = await context.newPage();
	await page.goto(`http://127.0.0.1:${port}/`);
	await page.waitForFunction('window.__result !== undefined', undefined, { timeout: 7_200_000, polling: 1000 });
	const peakRss = peakRendererBytes();
	const result = await page.evaluate('window.__result');
	if (!result.ok) throw new Error(result.error);
	const v = result.value;
	const g = (b: number) => (b / GiB).toFixed(2) + ' GiB';
	console.log(JSON.stringify({
		spot: which, mode: inMemory ? 'in memory, i16' : 'out of core, i16', engine: v.engine, setupMs: v.setupMs, msPerIteration: v.times, ioMsPerIteration: v.io,
		resident: g(v.report.residentBytes), file: g(v.report.fileBytes), readPerIteration: g(v.report.bytesRead / v.times.length), writtenPerIteration: g(v.report.bytesWritten / v.times.length),
		quota: g(v.quota), usage: g(v.usage), slots: v.slots, peakRendererRss: g(peakRss),
	}));
} finally {
	await context.close();
	server.close();
	rmSync(profile, { recursive: true, force: true });
}
process.exit(0);

/** Largest peak resident set (VmHWM) of any Chromium renderer: the tab and its workers. Linux only. */
function peakRendererBytes(): number {
	let peak = 0;
	for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
		try {
			const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
			if (!cmd.includes('--type=renderer')) continue;
			const hwm = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
			if (hwm) peak = Math.max(peak, Number(hwm[1]) * 1024);
		} catch {}
	}
	return peak;
}
