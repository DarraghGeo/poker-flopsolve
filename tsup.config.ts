import { defineConfig } from 'tsup';
import { browserPlatform } from './scripts/browser-platform.ts';

export default defineConfig([
	{
		entry: {
			index: 'src/index.ts',
			threads: 'src/threads.ts',
			worker: 'src/worker.ts',
			'engine-worker': 'src/engine-worker.ts',
		},
		format: ['esm'],
		dts: true,
		target: 'es2022',
		platform: 'node',
		splitting: false,
		sourcemap: true,
	},
	{
		// No Node imports; see src/platform/browser.ts. Single-threaded unless
		// the separate threads entry is imported and called.
		entry: { browser: 'src/index.ts', 'browser-threads': 'src/threads.ts' },
		format: ['esm'],
		target: 'es2022',
		platform: 'browser',
		splitting: false,
		sourcemap: true,
		esbuildPlugins: [browserPlatform],
	},
]);
