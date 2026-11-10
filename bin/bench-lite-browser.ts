/**
 * Lite browser benchmark (issue #133).
 *
 * Purpose: measure where `solveLite`'s time goes in the operator's own
 * browser, on their own cores: phase by phase, at each thread count. It
 * serves a cross-origin isolated page on localhost; open it in any browser,
 * press Run, and copy the JSON report it shows. The report is also saved
 * under `scratch/bench-lite/` and summarised here.
 *
 *   npm run bench:lite                                    # serve; open the printed URL
 *   npm run bench:lite -- --threads 1,2,4,max --variant both --mode settle
 *   npm run bench:lite -- --spots rainbow,monotone --no-resolve
 *   npm run bench:lite -- --headless                      # Playwright's Chromium, no window
 *
 * Flags set the page's defaults: `--spots` (rainbow, two-tone, monotone),
 * `--custom '<SpotConfig JSON>'`, `--threads`, `--variant` (default, keep,
 * both), `--mode` (settle, or a number of fixed iterations), `--no-resolve`,
 * `--port` (8788) and `--host` (127.0.0.1). Threads need the page to be
 * cross-origin isolated, which browsers allow only from a secure context:
 * localhost works, a LAN address over plain http does not.
 */

import { createRequire } from 'node:module';
import { startBenchServer } from '../bench/lite/user-bench-server.ts';
import type { PageDefaults } from '../bench/lite/user-bench-server.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : undefined;
};

const defaults: PageDefaults = {
	spots: option('spots'),
	custom: option('custom'),
	threads: option('threads'),
	variant: option('variant'),
	mode: option('mode'),
	resolve: args.includes('--no-resolve') ? '0' : undefined,
};
const query = new URLSearchParams();
for (const [key, value] of Object.entries(defaults)) if (value !== undefined) query.set(key, value);

const headless = args.includes('--headless');
const server = await startBenchServer({ port: Number(option('port') ?? (headless ? 0 : 8788)), host: option('host') });
const url = `${server.url}${query.size > 0 || headless ? `?${headless ? 'autorun=1&' : ''}${query}` : ''}`;

if (headless) {
	const { chromium } = createRequire(import.meta.url)('playwright') as {
		chromium: { launch(): Promise<{ newPage(): Promise<{ goto(url: string): Promise<unknown> }>; close(): Promise<void> }> };
	};
	const browser = await chromium.launch();
	const page = await browser.newPage();
	await page.goto(url);
	const report = await server.nextReport();
	await browser.close();
	await server.close();
	process.exit(report.errors.length > 0 || report.cases.length === 0 ? 1 : 0);
} else {
	console.log(`Open ${url} in the browser to measure, press Run, then copy the JSON report it shows.`);
	console.log('Reports are also saved under scratch/bench-lite/. Ctrl-C to stop.');
	for (;;) await server.nextReport();
}
