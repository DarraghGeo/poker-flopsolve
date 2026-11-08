/**
 * Opt-in threads for the browser build: `poker-flopsolve/threads`.
 *
 * Purpose: let a page split a solve across cores, as Node does, without the
 * main build depending on it. Nothing here runs unless it is imported and
 * called; a solve that never asks for threads is the same, bit for bit, as
 * one in a build without this entry.
 *
 * In a browser, call `enableThreads` once, inside a Web Worker on a
 * cross-origin isolated page, and await it before solving:
 *
 *   import { createRun, defineSpot } from 'poker-flopsolve';
 *   import { enableThreads } from 'poker-flopsolve/threads';
 *   const threads = await enableThreads();   // 1 if the page cannot thread
 *   const run = createRun(defineSpot(config), { workers: threads });
 *
 * In Node this resolves to the thread count straight away: Node starts
 * threads with each solve and needs no preparation.
 */

import { prepareThreads, threadsUnavailableReason } from './platform/node.ts';

/**
 * Start engine threads so that solves can use up to `count` threads, the
 * calling one included, and resolve to how many they can use: 1 where the
 * page cannot thread (see {@link threadsUnavailable}).
 *
 * Threads stay started between solves; a solve borrows them with
 * `workers: n` and returns them on `close()`. Calling again with a smaller
 * count stops the idle surplus, so `enableThreads(1)` stops them all.
 *
 * @param count threads wanted, the calling one included; defaults to the
 *   machine's core count (`navigator.hardwareConcurrency` in a browser)
 */
export function enableThreads(count?: number): Promise<number> {
	return prepareThreads(count);
}

/**
 * Why threads cannot run here, or null if they can. In a browser they need
 * a cross-origin isolated page (`Cross-Origin-Opener-Policy: same-origin`
 * and `Cross-Origin-Embedder-Policy: require-corp`) and a Web Worker to
 * solve in, since a page's main thread may not block.
 */
export function threadsUnavailable(): string | null {
	return threadsUnavailableReason();
}
