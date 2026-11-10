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
});
