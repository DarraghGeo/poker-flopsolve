import { defineConfig } from 'tsup';
import { browserPlatform } from './scripts/browser-platform.ts';

export default defineConfig([
	{
		entry: { index: 'src/index.ts', worker: 'src/worker.ts' },
		format: ['esm'],
		dts: true,
		target: 'es2022',
		platform: 'node',
		splitting: false,
		sourcemap: true,
	},
	{
		// Single-threaded, no Node imports; see src/platform/browser.ts.
		entry: { browser: 'src/index.ts' },
		format: ['esm'],
		target: 'es2022',
		platform: 'browser',
		splitting: false,
		sourcemap: true,
		esbuildPlugins: [browserPlatform],
	},
]);
