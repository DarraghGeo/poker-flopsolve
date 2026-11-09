/**
 * How much memory Chromium gives one buffer (issue #84).
 *
 * Purpose: find the real ceiling the WebAssembly engine works under in a
 * browser. Chromium refuses an ArrayBuffer of 2 GiB or more (#50), which is
 * why compact storage on the JavaScript engine comes in chunks; WebAssembly
 * memory is a single buffer that wasm32 lets reach 4 GiB. This tries both,
 * plain and shared, created at a size and grown to it, in a Web Worker on a
 * cross-origin isolated page, as a threaded solve runs, and touches the last
 * byte of each through a view.
 *
 *   node --import tsx bin/memory-ceiling.ts
 */

import { runInBrowser } from '../scripts/browser-harness.ts';

const GiB = 2 ** 30;
const SIZES = [2 * GiB - 65536, 2 * GiB, 3 * GiB, 4 * GiB - 65536, 4 * GiB];

const results = await runInBrowser<Record<string, string>>(
	`
	export default async function () {
		const sizes = ${JSON.stringify(SIZES)};
		const out = {};
		const touch = (buffer, bytes) => {
			const view = new Uint8Array(buffer, bytes - 16, 16);
			view[15] = 7;
			return view[15] === 7 ? 'ok' : 'unreadable';
		};
		const attempt = (label, make) => {
			try {
				out[label] = make();
			} catch (error) {
				out[label] = 'refused: ' + String(error).slice(0, 120);
			}
		};
		for (const bytes of sizes) {
			const pages = bytes / 65536;
			const gib = bytes / 2 ** 20 + ' MiB';
			attempt('ArrayBuffer ' + gib, () => touch(new ArrayBuffer(bytes), bytes));
			attempt('SharedArrayBuffer ' + gib, () => touch(new SharedArrayBuffer(bytes), bytes));
			attempt('WebAssembly.Memory ' + gib, () => {
				const memory = new WebAssembly.Memory({ initial: pages });
				return touch(memory.buffer, bytes);
			});
			attempt('shared WebAssembly.Memory ' + gib, () => {
				const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
				return touch(memory.buffer, bytes);
			});
			attempt('WebAssembly.Memory grown to ' + gib, () => {
				const memory = new WebAssembly.Memory({ initial: 1 });
				memory.grow(pages - 1);
				return touch(memory.buffer, bytes);
			});
			attempt('shared WebAssembly.Memory grown to ' + gib, () => {
				const memory = new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true });
				memory.grow(pages - 1);
				return touch(memory.buffer, bytes);
			});
		}
		out.crossOriginIsolated = String(self.crossOriginIsolated);
		out.userAgent = navigator.userAgent;
		return out;
	}
	`,
	600_000,
	{ isolated: true },
);

for (const [label, result] of Object.entries(results)) console.log(`${label.padEnd(44)} ${result}`);
