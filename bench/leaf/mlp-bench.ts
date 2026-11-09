/**
 * Inference cost of the leaf MLP in the browser: one forward pass over a
 * flop leaf's rows (every turn card, both players' hands), plain float32
 * JavaScript in a Web Worker in headless Chromium. Weights are random; only
 * the shape matters for time.
 *
 *   node --import tsx bench/leaf/mlp-bench.ts
 */
import { runInBrowser } from '../../scripts/browser-harness.ts';

const ROWS = 49 * 360;
const result = await runInBrowser<Record<string, number>>(
	`
	function forward(x, rows, sizes, weights) {
		let input = x;
		for (let l = 0; l + 1 < sizes.length; l++) {
			const a = sizes[l], b = sizes[l + 1], w = weights[l];
			const out = new Float32Array(rows * b);
			for (let r = 0; r < rows; r++) {
				const o = r * b, i0 = r * a;
				for (let i = 0; i < a; i++) {
					const v = input[i0 + i];
					if (v === 0) continue;
					const wi = i * b;
					for (let j = 0; j < b; j++) out[o + j] += v * w[wi + j];
				}
				if (l + 2 < sizes.length) for (let j = 0; j < b; j++) if (out[o + j] < 0) out[o + j] = 0;
			}
			input = out;
		}
		return input;
	}
	export default async function run() {
		const out = {};
		for (const h of [64, 256]) {
			const sizes = [36, h, h, 1];
			const weights = sizes.slice(1).map((b, l) => Float32Array.from({ length: sizes[l] * b }, () => Math.random() - 0.5));
			const x = Float32Array.from({ length: ${ROWS} * 36 }, () => Math.random());
			forward(x, ${ROWS}, sizes, weights);
			const t = performance.now();
			for (let k = 0; k < 5; k++) forward(x, ${ROWS}, sizes, weights);
			out['h' + h] = (performance.now() - t) / 5;
		}
		return out;
	}
	`,
	600_000,
);
console.log(`forward pass over ${ROWS} rows (one flop leaf, all turn cards):`, result, 'ms');
