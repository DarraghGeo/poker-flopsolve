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
	selectOption(selector: string, value: string): Promise<unknown>;
	inputValue(selector: string): Promise<string>;
	$(selector: string): Promise<{ boundingBox(): Promise<{ x: number; y: number; width: number; height: number }> } | null>;
	mouse: { move(x: number, y: number, options?: { steps: number }): Promise<void>; down(): Promise<void>; up(): Promise<void> };
	textContent(selector: string): Promise<string | null>;
	on(event: 'pageerror', handler: (error: Error) => void): void;
}
interface Browser {
	newPage(options?: { viewport: { width: number; height: number }; isMobile?: boolean; hasTouch?: boolean }): Promise<Page>;
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

	it('offers every betting choice and Lite at phone width', async (context) => {
		if (!browser) return context.skip();
		const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.goto(`${url}#board=Ks+9d+4c+2h+7s`);
		await page.waitForFunction("!document.getElementById('run').disabled", undefined, { timeout: 20_000 });
		// Nothing on the form runs off the side of a phone.
		const overflow = await page.evaluate<string[]>(
			"[...document.querySelectorAll('#mode button, #bets button, #raises button, #raise-sizes button, #allin + .track')]" +
				".filter((b) => { const r = b.getBoundingClientRect(); return r.left < 0 || r.right > document.documentElement.clientWidth; }).map((b) => b.textContent)",
		);
		expect(overflow).toEqual([]);
		expect(await page.evaluate<boolean>("document.getElementById('raise-sizes-field').hidden")).toBe(true);
		await page.click('#bets button:nth-child(2)'); // 33%
		await page.click('#bets button:nth-child(6)'); // 100%
		await page.click('#raises button:nth-child(3)'); // 2 raises
		expect(await page.evaluate<boolean>("document.getElementById('raise-sizes-field').hidden")).toBe(false);
		await page.click('#raise-sizes button:nth-child(3)'); // 3x
		await page.click('#mode button:nth-child(2)'); // Lite
		const hash = new URLSearchParams(await page.evaluate<string>('location.hash.slice(1)'));
		expect(hash.get('bets')).toBe('0.33,0.66,1');
		expect(hash.get('raises')).toBe('2');
		expect(hash.get('rx')).toBe('3');
		expect(hash.get('mode')).toBe('lite');
		await page.waitForFunction("!document.getElementById('run').disabled", undefined, { timeout: 20_000 });
		await page.click('#run');
		await page.waitForSelector('#results:not([hidden])', { timeout: 120_000 });
		expect(await page.textContent('#results')).toContain('33% + 66% + 100% pot, 2 raises of 3×');
		expect(errors).toEqual([]);
	});

	it('walks through the solution, street by street', async (context) => {
		if (!browser) return context.skip();
		const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.goto(`${url}#board=As+Kh+7d+2c&target=2&oop=AA,KK,77,AKs,65s&ip=QQ,JJ,AJs,KJs,T9s`);
		await page.waitForFunction("!document.getElementById('run').disabled", undefined, { timeout: 20_000 });
		await page.click('#run');
		await page.waitForSelector('#results:not([hidden])', { timeout: 60_000 });
		await page.waitForSelector('#explore .step-into', { timeout: 20_000 });
		const line = (): Promise<string | null> => page.textContent('#explore .spot-line');
		expect(await line()).toMatch(/^OOP to act · Turn/);
		// OOP checks, IP checks: the river is dealt and OOP acts again.
		await page.click('#explore .step-into[data-action="0"]');
		await page.waitForFunction("document.querySelector('#explore .spot-line').textContent.startsWith('IP')", undefined, { timeout: 20_000 });
		await page.click('#explore .step-into[data-action="0"]');
		await page.waitForFunction("document.querySelector('#explore .spot-line').textContent.includes('River')", undefined, { timeout: 20_000 });
		expect(await line()).toMatch(/^OOP to act · River/);
		const cards = async (): Promise<string> => (await page.textContent('#explore .spot-line .mono')) ?? '';
		const before = await cards();
		const options = await page.evaluate<string[]>("[...document.querySelectorAll('#runout option')].map((o) => o.value)");
		expect(options.length).toBeGreaterThan(30);
		const selected = await page.evaluate<string>("document.getElementById('runout').value");
		await page.selectOption('#runout', options.find((v) => v !== selected)!);
		await page.waitForFunction(`document.querySelector('#explore .spot-line .mono').textContent !== ${JSON.stringify(before)}`, undefined, { timeout: 20_000 });
		expect((await cards()).startsWith('As Kh 7d 2c ')).toBe(true);
		expect(await page.textContent('#explore .line')).toContain('River');
		// Back to the start from the line.
		await page.click('#explore .crumb[data-trail="0"]');
		await page.waitForFunction("document.querySelector('#explore .spot-line').textContent.includes('Turn')", undefined, { timeout: 20_000 });
		expect(await page.evaluate<number>("document.querySelectorAll('#explore .crumb').length")).toBe(0);
		expect(errors).toEqual([]);
	});

	it('runs Lite and reports what it simplified', async (context) => {
		if (!browser) return context.skip();
		const page = await browser.newPage();
		await page.goto(`${url}#board=As+Kh+7d+2c&mode=lite&sizes=two&raise=1&oop=AA,KK,77,AKs,AQs,KQs,65s&ip=QQ,JJ,AJs,KJs,QJs,JTs,T9s`);
		await page.waitForFunction("!document.getElementById('run').disabled", undefined, { timeout: 20_000 });
		expect(await page.textContent('#estimate')).toContain('River: one bet size (75% pot), no raises.');
		await page.click('#run');
		await page.waitForSelector('#results:not([hidden])', { timeout: 120_000 });
		expect(await page.textContent('#run-title')).toMatch(/^Settled in/);
		const results = (await page.textContent('#results')) ?? '';
		expect(results).toContain('What Lite simplified');
		expect(results).toContain('Limitations');
		expect(results).toContain('Not measured');
	});

	it('makes room for Lite\'s sampling when the tree alone fits the limit', async (context) => {
		if (!browser) return context.skip();
		const page = await browser.newPage();
		const anyTwo = encodeURIComponent(RANGE_PRESETS.find((p) => p.name === 'Any two')!.range);
		// 441 MB at 32 bits fits 512 MB, but sampling needs ~195 MB more.
		await page.goto(`${url}#mode=lite&raise=1&memory=512&ip=${anyTwo}`);
		await page.waitForFunction("!document.getElementById('run').disabled", undefined, { timeout: 20_000 });
		await page.click('#run');
		await page.waitForFunction("document.querySelectorAll('.step.done').length >= 3 || !document.getElementById('results').hidden", undefined, { timeout: 60_000 });
		expect(await page.textContent('#run-title')).toBe('Solving');
		expect(await page.textContent('#run-sub')).toContain('compressed');
		await page.click('#stop');
		await page.waitForSelector('#results:not([hidden])', { timeout: 120_000 });
		expect(await page.textContent('#run-title')).toMatch(/^Stopped/);
	});
});
