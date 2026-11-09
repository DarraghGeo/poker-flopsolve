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
import { ENGINE_STORAGE_WASM } from './wasm/engine-storage.ts';
import { ENGINE_STORAGE_SHARED_WASM } from './wasm/engine-storage-shared.ts';

export type { WasmStorage } from './engine.ts';

/** The storage engine, to pass as `SolveOptions.wasmStorage`. */
export const wasmStorage: WasmStorage = { plain: ENGINE_STORAGE_WASM, shared: ENGINE_STORAGE_SHARED_WASM };
