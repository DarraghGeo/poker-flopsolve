/**
 * Run solver code in a real browser.
 *
 * Purpose: one way to check the browser build actually works, shared by the
 * browser test and the browser bench.
 *
 * The given module is bundled exactly as the browser build is — the platform
 * module swapped, nothing from Node allowed — then run inside a Web Worker in
 * headless Chromium, which is how a page should host a solve. The module's
 * default export is awaited and its result posted back. By default the page is
 * served without cross-origin isolation headers on purpose: the browser build
 * must not need them. `{ isolated: true }` adds them, for the opt-in threads.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { browserPlatform } from './browser-platform.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Thrown when no Playwright Chromium is installed, so callers can skip. */
export class NoBrowserError extends Error {}

interface Playwright {
	chromium: {
		launch(options?: Record<string, unknown>): Promise<{
			newPage(): Promise<{
				goto(url: string): Promise<unknown>;
				waitForFunction(fn: string, arg?: unknown, options?: { timeout: number }): Promise<unknown>;
				evaluate<T>(fn: string): Promise<T>;
				on(event: 'console' | 'pageerror', handler: (value: { toString(): string }) => void): void;
			}>;
			close(): Promise<void>;
		}>;
	};
}

function loadPlaywright(): Playwright {
	try {
		return createRequire(import.meta.url)('playwright') as Playwright;
	} catch {
		throw new NoBrowserError('Playwright is not installed; browser checks need it');
	}
}

/**
 * Bundle a module for the browser, refusing any Node import.
 * @param source TypeScript whose default export is an async function
 */
export async function bundleForBrowser(source: string): Promise<string> {
	const result = await build({
		stdin: { contents: source, resolveDir: ROOT, loader: 'ts', sourcefile: 'browser-entry.ts' },
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		write: false,
		logLevel: 'silent',
		plugins: [browserPlatform],
	});
	return result.outputFiles[0].text;
}

const WORKER_SHIM = `
import run from './entry.js';
run().then(
	(value) => postMessage({ ok: true, value }),
	(error) => postMessage({ ok: false, error: String(error && error.stack || error) }),
);
`;

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
const worker = new Worker('./worker.js', { type: 'module' });
worker.onmessage = (event) => { window.__result = event.data; };
worker.onerror = (event) => { window.__result = { ok: false, error: event.message || 'worker failed to load' }; };
</script>`;

/** The headers that make a page cross-origin isolated, which threads need. */
export const ISOLATION_HEADERS = {
	'cross-origin-opener-policy': 'same-origin',
	'cross-origin-embedder-policy': 'require-corp',
} as const;

/**
 * Run a module's default export in a Web Worker in headless Chromium.
 * @param source TypeScript whose default export is an async function returning JSON-safe data
 * @param timeoutMs how long to wait for it
 * @param options `isolated` serves the page cross-origin isolated; `launch`
 *   is passed to Playwright's `chromium.launch` (flags, headed, a channel)
 */
export async function runInBrowser<T>(
	source: string,
	timeoutMs = 120_000,
	options: { isolated?: boolean; launch?: Record<string, unknown> } = {},
): Promise<T> {
	const playwright = loadPlaywright();
	const entry = await bundleForBrowser(source);
	const files: Record<string, [string, string]> = {
		'/': ['text/html', PAGE],
		'/worker.js': ['text/javascript', WORKER_SHIM],
		'/entry.js': ['text/javascript', entry],
	};
	const server = createServer((request, response) => {
		const file = files[request.url ?? '/'];
		if (!file) {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { 'content-type': file[0], ...(options.isolated ? ISOLATION_HEADERS : {}) }).end(file[1]);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

	let browser;
	try {
		browser = await playwright.chromium.launch(options.launch);
	} catch (error) {
		server.close();
		throw new NoBrowserError(`Chromium could not start: ${String(error)}`);
	}
	try {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.toString()));
		await page.goto(`http://127.0.0.1:${port}/`);
		await page.waitForFunction('window.__result !== undefined', undefined, { timeout: timeoutMs });
		const result = await page.evaluate<{ ok: boolean; value?: T; error?: string }>('window.__result');
		if (!result.ok) throw new Error(`In the browser: ${result.error}`);
		if (errors.length > 0) throw new Error(`Page errors: ${errors.join('\n')}`);
		return result.value as T;
	} finally {
		await browser.close();
		server.close();
	}
}
