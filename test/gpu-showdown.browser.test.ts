/**
 * The WebGPU prototype's kernels (bench/gpu, issue #39), run on a GPU.
 *
 * In headless Chromium with WebGPU switched on, the WGSL showdown and regret
 * matching must agree with the engine's WebAssembly code on every river job
 * of a turn spot, packed and plain lists alike. The adapter here is usually
 * SwiftShader, which is fine for agreement, though not for timing. The test
 * skips where there is no Playwright Chromium or no adapter.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SpotConfig } from '../src/index.ts';
import { compileBenchWasm } from '../bench/gpu/compile.ts';
import type { ExperimentResult } from '../bench/gpu/experiment.ts';
import { NoBrowserError, runInBrowser } from '../scripts/browser-harness.ts';
import { ARCHETYPES } from '../bench/leaf/lib.ts';

const OOP = ARCHETYPES.benchOop;
const IP = ARCHETYPES.benchIp;

const SPOTS: Record<string, SpotConfig> = {
	// No symmetry left: plain lists.
	rainbow: { board: 'AsKh7d2c', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.66]], maxRaises: 1 },
	// Three suits alike on the river: packed lists.
	monotone: { board: 'Ks9s4s2s', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.66]], maxRaises: 1 },
};

let results: Record<string, ExperimentResult> | null = null;

beforeAll(async () => {
	const wasm = Buffer.from(compileBenchWasm()).toString('base64');
	const source = `
		import experiment from './bench/gpu/experiment.ts';
		const SPOTS = ${JSON.stringify(SPOTS)};
		export default async function run() {
			const out = {};
			for (const [name, config] of Object.entries(SPOTS)) {
				out[name] = await experiment({ config, wasm: ${JSON.stringify(wasm)}, reps: 0, iterations: 0, verifyOnly: true });
			}
			return out;
		}
	`;
	try {
		results = await runInBrowser<Record<string, ExperimentResult>>(source, 170_000, {
			launch: { args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader'] },
		});
	} catch (error) {
		if (!(error instanceof NoBrowserError)) throw error;
		console.warn(`Skipping WebGPU checks: ${error.message}`);
	}
}, 180_000);

describe.each(Object.keys(SPOTS))('WebGPU kernels: %s', (name) => {
	it('agree with the engine', (context) => {
		if (!results || !results[name].adapter) {
			console.warn('Skipping WebGPU checks: no adapter');
			context.skip();
			return;
		}
		const result = results[name];
		expect(result.jobs).toBeGreaterThan(0);
		if (name === 'monotone') expect(result.packedJobs).toBeGreaterThan(0);
		else expect(result.packedJobs).toBe(0);
		// f32 sums against the engine's f64, relative to the job's stakes.
		expect(result.showdownError).toBeLessThan(1e-5);
		expect(result.matchError).toBeLessThan(1e-6);
	});
});
