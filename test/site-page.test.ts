/**
 * The benchmark page (issue #135), built and run in headless Chromium.
 *
 * Served as GitHub Pages serves it, with no cross-origin isolation headers,
 * so the page's own service worker must supply them; then a small spot is
 * benchmarked end to end through the form. Skipped where no Playwright
 * Chromium is installed.
 */

import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RANGE_PRESETS } from '../site/lib/ranges.ts';
import { validRange } from '../site/lib/settings.ts';
import { buildSite } from '../scripts/build-site.ts';
import { serveSite } from '../scripts/serve-site.ts';

interface Page {
	goto(url: string): Promise<unknown>;
	waitForTimeout(ms: number): Promise<void>;
	waitForSelector(selector: string, options?: { timeout: number }): Promise<unknown>;
	waitForFunction(fn: string, arg?: unknown, options?: { timeout: number }): Promise<unknown>;
	evaluate<T>(fn: string): Promise<T>;
	click(selector: string): Promise<void>;
	inputValue(selector: string): Promise<string>;
	$(selector: string): Promise<{ boundingBox(): Promise<{ x: number; y: number; width: number; height: number }> } | null>;
	mouse: { move(x: number, y: number, options?: { steps: number }): Promise<void>; down(): Promise<void>; up(): Promise<void> };
	textContent(selector: string): Promise<string | null>;
	on(event: 'pageerror', handler: (error: Error) => void): void;
}
interface Browser {
	newPage(): Promise<Page>;
	close(): Promise<void>;
}

function launcher(): { launch(): Promise<Browser> } | null {
	try {
		return (createRequire(import.meta.url)('playwright') as { chromium: { launch(): Promise<Browser> } }).chromium;
	} catch {
		return null;
	}
}

describe('site range presets', () => {
	it('all parse and hold hands', () => {
		for (const preset of RANGE_PRESETS) expect(validRange(preset.range), preset.name).toBe(true);
	});
});

describe('site page in a browser', () => {
	let browser: Browser | null = null;
	let close: () => void = () => {};
	let url = '';

	beforeAll(async () => {
		const chromium = launcher();
		if (!chromium) return;
		try {
			browser = await chromium.launch();
		} catch {
			return;
		}
		await buildSite({ minify: false });
		const served = await serveSite();
		url = served.url;
		close = () => served.server.close();
	});

	afterAll(async () => {
		await browser?.close();
		close();
	});

	it('isolates itself and benchmarks a spot', async (context) => {
		if (!browser) return context.skip();
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.goto(`${url}#board=As+Kh+7d+2c+9s&target=0.3`);
		await page.waitForFunction('window.crossOriginIsolated === true', undefined, { timeout: 20_000 });
		await page.waitForFunction("!document.getElementById('run').disabled", undefined, { timeout: 20_000 });
		expect(await page.textContent('#estimate')).toContain('river only');
		await page.click('#run');
		await page.waitForSelector('#results:not([hidden])', { timeout: 60_000 });
		expect(await page.textContent('#run-title')).toMatch(/^Reached 0\.3% in/);
		const threads = await page.evaluate<string>(
			"[...document.querySelectorAll('.kv dt')].find((d) => d.textContent === 'Threads used').nextElementSibling.textContent",
		);
		expect(Number.parseInt(threads, 10)).toBeGreaterThan(0);
		expect(await page.evaluate<boolean>("document.getElementById('results').textContent.includes('Cross-origin isolatedYes')")).toBe(true);
		expect(errors).toEqual([]);
	});

	it('survives a spot nobody can exploit, and stops on request', async (context) => {
		if (!browser) return context.skip();
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		// Royal flush on board, a tiny stack: exploitability is exactly 0.
		await page.goto(`${url}#board=As+Ks+Qs+Js+Ts&stack=0.001&oop=AA&ip=22`);
		await page.waitForFunction("!document.getElementById('run').disabled", undefined, { timeout: 20_000 });
		await page.click('#run');
		await page.waitForSelector('#results:not([hidden])', { timeout: 30_000 });
		expect(await page.textContent('#run-title')).toMatch(/^Reached/);

		const second = await browser.newPage();
		second.on('pageerror', (error) => errors.push(error.message));
		await second.goto(`${url}#board=Ks+9d+4c`);
		await second.waitForFunction("!document.getElementById('run').disabled", undefined, { timeout: 20_000 });
		await second.click('#run');
		await second.waitForFunction("document.querySelectorAll('.step.done').length >= 3", undefined, { timeout: 30_000 });
		await second.click('#stop');
		await second.waitForSelector('#results:not([hidden])', { timeout: 60_000 });
		expect(await second.textContent('#run-title')).toMatch(/^Stopped/);
		expect(errors).toEqual([]);
	});

	it('paints a stroke across the grid and keeps single combinations', async (context) => {
		if (!browser) return context.skip();
		const page = await browser.newPage();
		await page.goto(`${url}#oop=AA,AsKs`);
		await page.waitForFunction("document.getElementById('range-text').value === 'AA,AsKs'", undefined, { timeout: 20_000 });
		const box = await (await page.$('#grid'))!.boundingBox();
		const cell = box.width / 13;
		// One fast stroke from KK to K8s: the cells in between are filled in.
		await page.mouse.move(box.x + cell * 1.5, box.y + cell * 1.5);
		await page.mouse.down();
		await page.mouse.move(box.x + cell * 6.5, box.y + cell * 1.5, { steps: 1 });
		await page.mouse.up();
		expect(await page.inputValue('#range-text')).toBe('KK+,K8s+,AsKs');
	});
});
