/**
 * Opt-in 16-bit and compact storage on the WebAssembly engine:
 * `poker-flopsolve/wasm-storage` (issue #84).
 *
 * Purpose: run `precision: 'i16'` and `compactStorage` solves on the
 * WebAssembly engine, threads included, where they would otherwise run on
 * the slower JavaScript one. They follow src/cfr.ts's 16-bit and compact
 * updates step for step, in the engine's 32-bit vectors.
 *
 *   import { createRun, defineSpot } from 'poker-flopsolve';
 *   import { wasmStorage } from 'poker-flopsolve/wasm-storage';
 *   const run = createRun(defineSpot(config), { precision: 'i16', wasmStorage });
 *
 * The engine's bytes live only here, so a build that never imports this
 * entry is unchanged, and a solve that does not pass it runs as before.
 */

import type { WasmStorage } from './engine.ts';
import type { SolveOptions, SpotConfig } from './index.ts';
import { ENGINE_STORAGE_WASM } from './wasm/engine-storage.ts';
import { ENGINE_STORAGE_SHARED_WASM } from './wasm/engine-storage-shared.ts';

export type { WasmStorage } from './engine.ts';

/** The storage engine, to pass as `SolveOptions.wasmStorage`. */
export const wasmStorage: WasmStorage = { plain: ENGINE_STORAGE_WASM, shared: ENGINE_STORAGE_SHARED_WASM };

/** Settings for `largeTree`. */
export interface LargeTreeOptions {
	/**
	 * 'i16' (the default): 16-bit storage, the more accurate. 'compact':
	 * `compactStorage` at its defaults (8 bits, with sums), about two thirds
	 * of the memory and a little slower, for a tab with less to give.
	 */
	readonly storage?: 'i16' | 'compact';
}

/** What `largeTree` returns: the spot's settings and the solve's. */
export interface LargeTree {
	readonly config: SpotConfig;
	readonly options: SolveOptions;
}

/**
 * A preset for a tree too big for memory, opt-in (issue #102): the
 * combination of memory levers that measured best on the round's target T.
 *
 *   const { config, options } = largeTree(myConfig);
 *   const run = createRun(defineSpot(config), { ...options, workers: 4 });
 *
 * It returns `config` with `thinSizes` set, and solve options for 16-bit
 * storage on the WebAssembly engine (`precision: 'i16'`, `wasmStorage`) with
 * `chanceSampling` at its defaults. With `storage: 'compact'` it sets
 * `compactStorage` instead of 16 bits (a `compactStorage` already given is
 * kept). Spread your own options over it (workers, iterations, a target);
 * nothing else is changed, and a solve that does not use it is unchanged.
 *
 * Measured on T (As Kh 7d, pot 55, stack 975, 0.33 / 0.75 / 1.5 pot, a
 * 0.75 raise and all-in, three aggressions, every street: 17.2 GiB at 32
 * bits) on 4 threads. Against `thinSizes` alone at 32 bits solved for 600
 * iterations (`bench/combos/`), the root play settled within 0.02% of pot
 * of its final value in 155 s and ended at that reference's own floor
 * (0.031% of pot lost at the root, 0.020% after a check), per-hand root EVs
 * 0.05% of pot off on average. Storage 1.47 GiB, peak 1.97 GiB in Node
 * and 1.87 GiB in Chromium, 0.25 and 0.23 s an iteration. Compact: 168 s,
 * the same root play, 1.48 / 1.42 GiB peak. What `thinSizes` itself costs
 * against the full tree was measured on T₀ against an exact solve: root
 * play 0.04% of pot, per-hand root EVs about 1.5% of pot off on average.
 * See the `Approximations` notes in src/index.ts for the combinations
 * measured and left out.
 */
export function largeTree(config: SpotConfig, preset: LargeTreeOptions = {}): LargeTree {
	const storage = preset.storage ?? 'i16';
	if (storage !== 'i16' && storage !== 'compact') {
		throw new Error(`largeTree: storage must be 'i16' or 'compact', got ${String(storage)}`);
	}
	const sampling: SolveOptions = { approximations: { chanceSampling: {} } };
	return storage === 'i16'
		? { config: { ...config, thinSizes: true }, options: { precision: 'i16', wasmStorage, ...sampling } }
		: { config: { ...config, thinSizes: true, compactStorage: config.compactStorage ?? {} }, options: { wasmStorage, ...sampling } };
}
