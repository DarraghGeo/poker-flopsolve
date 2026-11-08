/**
 * Compile assembly/bench-showdown.ts with the engine's flags.
 *
 * Purpose: the bench's CPU side is built on demand rather than committed,
 * since nothing shipped uses it. Node-only.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASC_FLAGS } from '../../scripts/wasm-flags.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The bench module's bytes, compiled as scripts/build-wasm.ts compiles the engine. */
export function compileBenchWasm(): Uint8Array {
	const scratch = mkdtempSync(join(tmpdir(), 'bench-wasm-'));
	try {
		const out = join(scratch, 'bench.wasm');
		execFileSync(
			join(ROOT, 'node_modules', '.bin', 'asc'),
			['assembly/bench-showdown.ts', ...ASC_FLAGS, '-o', out],
			{ cwd: ROOT, stdio: 'pipe' },
		);
		return new Uint8Array(readFileSync(out));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
