/**
 * Opt-in out-of-core river storage: `poker-flopsolve/out-of-core`.
 *
 * Purpose: let a flop spot whose river storage is too big for memory solve
 * from a file, without the main build carrying the paging code. Nothing
 * here runs unless it is imported and handed to a solve; see `OutOfCore` in
 * the main entry for what it does and costs.
 *
 * In a browser, inside a Web Worker:
 *
 *   import { createRun, defineSpot } from 'poker-flopsolve';
 *   import { outOfCore } from 'poker-flopsolve/out-of-core';
 *   const root = await navigator.storage.getDirectory();
 *   const handle = await (await root.getFileHandle('river.bin', { create: true })).createSyncAccessHandle();
 *   const run = createRun(defineSpot({ ...config, maxBytes: 16 * 2 ** 30 }), { outOfCore: outOfCore(handle) });
 *
 * In Node, `outOfCore(openPageFile(path))`.
 */

import type { OutOfCore } from './index.ts';
import type { PageFile } from './paging.ts';
import { PAGING } from './paging.ts';
import { openPageFile as open } from './platform/node.ts';

export type { PageFile } from './paging.ts';
export type { OutOfCore, OutOfCoreReport } from './index.ts';

/** Page a solve's river through `file`; pass as `SolveOptions.outOfCore`. */
export function outOfCore(file: PageFile): OutOfCore {
	return { file, paging: PAGING };
}

/**
 * A page file on disk, in Node: created or truncated at `path`. Call
 * `close()` once the run is done with it. Not in a browser, where an OPFS
 * `FileSystemSyncAccessHandle` is the page file.
 */
export function openPageFile(path: string): PageFile & { close(): void } {
	return open(path);
}
