/**
 * The Lite browser benchmark (issue #133): its summary arithmetic, and the
 * page end to end in headless Chromium on a small spot (skipped where no
 * Playwright Chromium is installed).
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { startBenchServer } from '../bench/lite/user-bench-server.ts';
import type { CaseResult } from '../bench/lite/user-bench-summary.ts';
import { formatSummary, summarise } from '../bench/lite/user-bench-summary.ts';

/** A case whose iterations took `stepMs` in all, with `otherMs` outside them. */
function result(workers: number, iterations: number, stepMs: number, otherMs = 0, name = 'rainbow'): CaseResult {
	return {
		name, board: 'As Kh 7d', variant: 'default', mode: { kind: 'settle' }, threadsAsked: workers, threads: workers, workers,
		engine: 'wasm', estimateBytes: 0, kept: [], stoppedAt: 'settled', iterations,
		ms: { threads: 0, preset: otherMs, build: 0, alloc: 0, step: stepMs, check: 0, close: 0, resolve: 0, total: stepMs + otherMs },
		checks: [], resolve: null,
	};
}

describe('summarise', () => {
	it('compares per iteration against the fewest threads, with the Karp–Flatt serial fraction', () => {
		const rows = summarise([result(4, 400, 10_000), result(1, 400, 30_000, 10_000)]);
		expect(rows.map((r) => r.threads)).toEqual([1, 4]);
		const [one, four] = rows;
		expect(one.speedup).toBe(1);
		expect(one.serialFraction).toBeNull();
		expect(one.fixedShare).toBeCloseTo(0.25);
		expect(one.seconds).toBe(40);
		expect(four.msPerIteration).toBe(25);
		expect(four.speedup).toBe(3);
		expect(four.efficiency).toBe(0.75);
		// (1/3 - 1/4) / (1 - 1/4) = 1/9
		expect(four.serialFraction).toBeCloseTo(1 / 9);
	});

	it('keeps spots apart and compares runs that stopped at different counts per iteration', () => {
		const rows = summarise([result(1, 400, 40_000), result(2, 380, 19_000), result(2, 100, 1_000, 0, 'monotone')]);
		expect(rows.find((r) => r.name === 'rainbow' && r.threads === 2)!.speedup).toBe(2);
		expect(rows.find((r) => r.name === 'monotone')!.speedup).toBe(1);
		expect(formatSummary(rows).split('\n')).toHaveLength(4);
	});
});

function playwright(): { chromium: { launch(): Promise<{ newPage(): Promise<{ goto(url: string): Promise<unknown> }>; close(): Promise<void> }> } } | null {
	try {
		return createRequire(import.meta.url)('playwright');
	} catch {
		return null;
	}
}

describe('the page', () => {
	const pw = playwright();
	it.skipIf(pw === null)('runs each case in Chromium, threaded, and posts the report back', async (context) => {
		const server = await startBenchServer({ port: 0, save: false });
		const custom = JSON.stringify({
			board: 'As Kh 7d', pot: 60, stack: 100, oop: 'AA,KK,AKs,76s', ip: 'QQ,JJ,AJs,T9s', betSizes: [[0.66]], maxRaises: 1,
		});
		const query = new URLSearchParams({ autorun: '1', spots: '', custom, threads: '1,2', variant: 'both', mode: '20', resolve: '1' });
		let browser;
		try {
			browser = await pw!.chromium.launch();
		} catch {
			// Playwright without a Chromium that starts: skipped, not passed.
			await server.close();
			context.skip();
			return;
		}
		try {
			const page = await browser.newPage();
			await page.goto(`${server.url}?${query}`);
			const report = await server.nextReport();
			expect(report.errors).toEqual([]);
			expect(report.environment?.crossOriginIsolated).toBe(true);
			expect(report.cases.map((c) => [c.variant, c.workers])).toEqual([['default', 1], ['default', 2], ['keep', 1], ['keep', 2]]);
			for (const c of report.cases) {
				expect(c.iterations).toBe(20);
				expect(c.stoppedAt).toBe('iterations');
				expect(c.resolve?.turn).toBe('2c');
				expect(c.ms.total).toBeCloseTo(c.ms.preset + c.ms.build + c.ms.alloc + c.ms.step + c.ms.check + c.ms.close);
			}
		} finally {
			await browser.close();
			await server.close();
		}
	});

	it.skipIf(pw === null)('posts a report naming bad settings instead of running nothing', async (context) => {
		const server = await startBenchServer({ port: 0, save: false });
		let browser;
		try {
			browser = await pw!.chromium.launch();
		} catch {
			await server.close();
			context.skip();
			return;
		}
		try {
			const page = await browser.newPage();
			await page.goto(`${server.url}?autorun=1&spots=montone&mode=0&variant=keeep`);
			const report = await server.nextReport();
			expect(report.cases).toEqual([]);
			expect(report.errors).toHaveLength(1);
			expect(report.errors[0].error).toMatch(/unknown spot "montone".*unknown variant "keeep".*mode must be/);
		} finally {
			await browser.close();
			await server.close();
		}
	});
});

describe('the server', () => {
	it('refuses reports from another origin, and bodies that are not reports', async () => {
		const server = await startBenchServer({ port: 0, save: false });
		try {
			const post = (body: string, headers: Record<string, string> = {}): Promise<number> =>
				fetch(`${server.url}result`, { method: 'POST', body, headers }).then((r) => r.status);
			expect(await post('{"cases":[],"errors":[]}', { origin: 'http://evil.example' })).toBe(403);
			expect(await post('{}')).toBe(400);
			expect(await post('not json')).toBe(400);
			expect(await post('{"cases":[],"errors":[],"environment":null}')).toBe(204);
			expect((await server.nextReport()).environment).toBeNull();
		} finally {
			await server.close();
		}
	});
});
