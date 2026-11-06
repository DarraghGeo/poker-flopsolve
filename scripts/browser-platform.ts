/**
 * esbuild plugin for the browser build.
 *
 * Purpose: swap `src/platform/node.ts` for `src/platform/browser.ts`, which
 * has the same exports and no Node imports. Everything else in the solver is
 * plain TypeScript over typed arrays, so this one substitution is the whole
 * port. Shared by `tsup.config.ts` and the browser test and bench.
 */

import { fileURLToPath } from 'node:url';
import type { Plugin } from 'esbuild';

const BROWSER_PLATFORM = fileURLToPath(new URL('../src/platform/browser.ts', import.meta.url));

export const browserPlatform: Plugin = {
	name: 'browser-platform',
	setup(build) {
		build.onResolve({ filter: /[\\/]platform[\\/]node\.ts$/ }, () => ({ path: BROWSER_PLATFORM }));
	},
};
