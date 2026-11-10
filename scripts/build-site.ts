/**
 * Build the benchmark page (issue #135) for GitHub Pages.
 *
 * Purpose: bundle `site/app.ts` and the solver worker `site/worker.ts` the
 * way the package's browser build is bundled (the platform module swapped,
 * nothing from Node), and copy the static files beside them, into
 * `site/dist/`: a folder any static host can serve as it is.
 *
 *   npm run site:build
 *
 * The workflow `.github/workflows/pages.yml` runs this and publishes the
 * folder.
 */

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { browserPlatform } from './browser-platform.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SITE = join(ROOT, 'site');
export const SITE_OUT = join(SITE, 'dist');

/** Bundle and copy the page into `site/dist/`. */
export async function buildSite(options: { minify?: boolean } = {}): Promise<string> {
	rmSync(SITE_OUT, { recursive: true, force: true });
	mkdirSync(SITE_OUT, { recursive: true });
	await build({
		entryPoints: { app: join(SITE, 'app.ts'), worker: join(SITE, 'worker.ts') },
		outdir: SITE_OUT,
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify: options.minify ?? true,
		sourcemap: true,
		logLevel: 'warning',
		plugins: [browserPlatform],
	});
	for (const file of ['index.html', 'styles.css', 'coi.js', 'coi-sw.js']) copyFileSync(join(SITE, file), join(SITE_OUT, file));
	// GitHub Pages: serve files as they are, no Jekyll.
	writeFileSync(join(SITE_OUT, '.nojekyll'), '');
	return SITE_OUT;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const out = await buildSite();
	console.log(`site built in ${out}`);
}
