/**
 * Can a browser tab's worker hold T's compact storage? Allocates the arrays
 * compact storage would for T in headless Chromium and touches every page.
 *
 *   node --import tsx bench/storage/browser-alloc.ts
 */

import { runInBrowser } from '../../scripts/browser-harness.ts';

// T: 2,301M slots, 858M hand rows (bench/storage/bytes.ts).
const result = await runInBrowser<string[]>(
	`
	export default async function run() {
		const out = [];
		for (const [label, sizes] of [
			['per block', [2301e6]],
			['per hand', [2301e6, 858e6]],
		]) {
			try {
				const arrays = sizes.map((n) => new Int8Array(n));
				for (const a of arrays) for (let i = 0; i < a.length; i += 4096) a[i] = 1;
				out.push(label + ': ok, ' + (sizes.reduce((s, n) => s + n, 0) / 2 ** 30).toFixed(2) + ' GiB');
			} catch (e) {
				out.push(label + ': ' + e);
			}
		}
		return out;
	}
	`,
	600_000,
);
console.log(result.join('\\n'));
