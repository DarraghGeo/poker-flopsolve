/**
 * Issue #55, step 1: OPFS throughput with a synchronous access handle in a
 * worker, in headless Chromium, before building any paging.
 *
 *   node --import tsx bench/ooc/opfs.ts [--gib 4] [--chunk-mib 64] [--memory] [--drop]
 *
 * A persistent profile by default, so OPFS lives on disk as it would in a
 * normal tab; `--memory` uses Playwright's default throwaway context, which
 * Chromium treats like incognito (OPFS held in memory, small quota).
 *
 * Measures, on one file of `--gib` GiB written in `--chunk-mib` chunks:
 * sequential write (+ flush), sequential read, and the paging pattern — read
 * a chunk, write it back in place — which is what a CFR pass over paged
 * river blocks does. Also reports `navigator.storage.estimate()`.
 */

import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleForBrowser } from '../../scripts/browser-harness.ts';

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
	const at = args.indexOf(name);
	return at >= 0 ? Number(args[at + 1]) : fallback;
};
const gib = flag('--gib', 4);
const chunkMiB = flag('--chunk-mib', 64);
const memory = args.includes('--memory');
const passes = flag('--passes', 2);
// Drop the OS page cache before each read, so reads come from the disk (root, Linux).
const drop = args.includes('--drop');

const source = `
export default async function run() {
	const DROP = ${drop}, GIB = ${gib}, CHUNK = ${chunkMiB} * 2 ** 20, PASSES = ${passes};
	const total = Math.round(GIB * 2 ** 30);
	const chunks = Math.ceil(total / CHUNK);
	const out = { quotaBefore: await navigator.storage.estimate() };
	const root = await navigator.storage.getDirectory();
	try { await root.removeEntry('bench.bin'); } catch {}
	const file = await root.getFileHandle('bench.bin', { create: true });
	const handle = await file.createSyncAccessHandle();
	const buf = new Uint8Array(CHUNK);
	for (let i = 0; i < CHUNK; i += 4096) buf[i] = i & 255;
	const mibs = (bytes, ms) => +(bytes / 2 ** 20 / (ms / 1000)).toFixed(0);
	const rate = { write: [], read: [], readWrite: [] };
	const dropCache = async () => { if (DROP) await fetch('/drop'); };
	try {
		for (let pass = 0; pass < PASSES; pass++) {
			let t = performance.now();
			for (let c = 0; c < chunks; c++) {
				buf[0] = c;
				const n = handle.write(buf, { at: c * CHUNK });
				if (n !== CHUNK) throw new Error('short write ' + n);
			}
			handle.flush();
			rate.write.push(mibs(chunks * CHUNK, performance.now() - t));

			await dropCache();
			t = performance.now();
			let check = 0;
			for (let c = 0; c < chunks; c++) {
				const n = handle.read(buf, { at: c * CHUNK });
				if (n !== CHUNK) throw new Error('short read ' + n);
				check += buf[0] === (c & 255) ? 1 : 0;
			}
			if (check !== chunks) throw new Error('read back wrong data');
			rate.read.push(mibs(chunks * CHUNK, performance.now() - t));

			// Paging: read a page, (compute), write it back where it was.
			await dropCache();
			t = performance.now();
			for (let c = 0; c < chunks; c++) {
				handle.read(buf, { at: c * CHUNK });
				buf[1]++;
				handle.write(buf, { at: c * CHUNK });
			}
			handle.flush();
			// MiB of storage paged per second: each byte read once and written once.
			rate.readWrite.push(mibs(chunks * CHUNK, performance.now() - t));
		}
		out.fileBytes = handle.getSize();
		out.quotaDuring = await navigator.storage.estimate();
	} finally {
		handle.close();
		await root.removeEntry('bench.bin');
	}
	out.rate = rate;
	out.config = { GIB, chunkMiB: CHUNK / 2 ** 20, chunks };
	return out;
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
	if (req.url === '/drop') {
		execSync('sync; echo 3 > /proc/sys/vm/drop_caches');
		return void res.writeHead(200).end('ok');
	}
	const f = files[req.url ?? '/'];
	if (!f) return void res.writeHead(404).end();
	res.writeHead(200, { 'content-type': f[0] }).end(f[1]);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address() as AddressInfo;

const { chromium } = createRequire(import.meta.url)('playwright');
const profile = mkdtempSync(join(process.env.OOC_PROFILE_DIR ?? tmpdir(), 'opfs-'));
const context = memory ? await (await chromium.launch()).newContext() : await chromium.launchPersistentContext(profile);
try {
	const page = await context.newPage();
	await page.goto(`http://127.0.0.1:${port}/`);
	await page.waitForFunction('window.__result !== undefined', undefined, { timeout: 1_800_000 });
	const result = await page.evaluate('window.__result');
	if (!result.ok) throw new Error(result.error);
	const v = result.value;
	const g = (b: number) => (b / 2 ** 30).toFixed(1) + ' GiB';
	console.log(JSON.stringify({ mode: memory ? 'in-memory context' : 'persistent profile', ...v.config, rate_MiBps: v.rate,
		quota: g(v.quotaBefore.quota), usageDuring: g(v.quotaDuring.usage), fileBytes: g(v.fileBytes) }));
} finally {
	await context.close();
	server.close();
	rmSync(profile, { recursive: true, force: true });
}
process.exit(0);
