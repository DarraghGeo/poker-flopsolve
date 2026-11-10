/**
 * One case of the Lite browser benchmark (issue #133), run in a Web Worker.
 *
 * Purpose: time `solveLite` the way a page pays for it, phase by phase, on
 * the operator's own browser and machine, so the numbers that decide where
 * to speed it up come from there rather than from a cloud container. It
 * does what `solveLite` does, stepped so each phase can be timed:
 * `litePreset` (the blueprint, and with `keepBudget` the picking solve),
 * `defineSpot`, `createRun`, then `run.step` in steps of `settle.every`
 * with a snapshot and `trackSettle` check after each, as `solve`'s settle
 * loop does, and `close`. Optionally one turn re-solve, as
 * `LiteSolution.resolve` makes it: check, check, then the first turn card
 * not on the board, for out of position, 200 iterations, at the caller's
 * full betting.
 *
 * `bin/bench-lite-browser.ts` serves the page that runs it.
 */

import { formatCards, parseCard } from '../../src/cards.ts';
import { bettingFrom, createRun, defineSpot, litePreset, resolveSubgame, simdAvailable, trackSettle } from '../../src/index.ts';
import type { SolveLiteOptions, SpotConfig } from '../../src/index.ts';
import { settlePlan } from '../../src/settle.ts';
import { enableThreads, threadsUnavailable } from '../../src/threads.ts';
import { NodeKind } from '../../src/tree.ts';
import { wasmStorage } from '../../src/wasm-storage.ts';
import type { BenchCheck, BenchEnvironment, BenchMode, BenchVariant, CaseResult } from './user-bench-summary.ts';

/** What the page asks a worker to run. */
export interface BenchCase {
	readonly name: string;
	readonly config: SpotConfig;
	readonly variant: BenchVariant;
	readonly threads: number;
	readonly mode: BenchMode;
	/** Time one turn re-solve after the blueprint. */
	readonly resolve: boolean;
}

/** What a worker posts while a case runs. */
export interface BenchProgress {
	readonly phase: string;
	readonly iterations: number;
	readonly ms: number;
}

const MiB = 2 ** 20;
/** `LiteSolution.resolve`'s default iterations. */
const RESOLVE_ITERATIONS = 200;

/** Where this worker runs. */
export function environment(): BenchEnvironment {
	const g = globalThis as unknown as {
		navigator?: { userAgent?: string; hardwareConcurrency?: number; deviceMemory?: number };
		crossOriginIsolated?: boolean;
	};
	return {
		userAgent: g.navigator?.userAgent ?? 'unknown',
		hardwareConcurrency: g.navigator?.hardwareConcurrency ?? 1,
		deviceMemory: g.navigator?.deviceMemory ?? null,
		crossOriginIsolated: g.crossOriginIsolated === true,
		threadsUnavailable: threadsUnavailable(),
		simd: simdAvailable(),
	};
}

/** Run one case and time every phase. */
export async function runCase(c: BenchCase, progress: (p: BenchProgress) => void = () => {}): Promise<CaseResult> {
	const now = (): number => performance.now();
	let t = now();
	const threads = await enableThreads(c.threads);
	const threadsMs = now() - t;

	const keep = c.variant === 'keep';
	const storage = keep ? { precision: 'i16' as const, wasmStorage } : {};
	const options: SolveLiteOptions = {
		workers: threads,
		...storage,
		...(keep ? { keepBudget: 150 * MiB } : {}),
		...(c.mode.kind === 'fixed' ? { settle: false, iterations: c.mode.iterations } : {}),
	};

	progress({ phase: keep ? 'preset and line pick' : 'preset', iterations: 0, ms: 0 });
	t = now();
	const preset = litePreset(c.config, options);
	const presetMs = now() - t;
	const share = preset.config.shareHistories;
	const kept = typeof share === 'object' ? [...(share.keepLines ?? [])] : [];

	t = now();
	const spot = defineSpot(preset.config);
	const buildMs = now() - t;

	t = now();
	const run = createRun(spot, preset.options);
	const allocMs = now() - t;

	// `solve`'s settle loop, timed: steps of `every`, a snapshot and check after each.
	const settle = preset.options.settle ? settlePlan(preset.options.settle) : null;
	const tracker = settle ? trackSettle(settle) : null;
	const every = settle?.every ?? 20;
	const cap = preset.options.iterations ?? 2000;
	const checks: BenchCheck[] = [];
	const started = now();
	let stepMs = 0;
	let checkMs = 0;
	let done = 0;
	let stoppedAt: CaseResult['stoppedAt'] = 'iterations';
	while (done < cap) {
		const until = Math.min(done + every, cap);
		const full = until - done === every;
		t = now();
		run.step(until - done);
		const thisStep = now() - t;
		stepMs += thisStep;
		done = until;
		let settled = false;
		let movement: number | null = null;
		if (tracker) {
			t = now();
			settled = full && tracker.check(run.snapshot(), done);
			checkMs += now() - t;
			movement = full && Number.isFinite(tracker.movement) ? tracker.movement : null;
		}
		checks.push({ iterations: done, ms: now() - started, stepMs: thisStep, movement });
		progress({ phase: 'solving', iterations: done, ms: now() - started });
		if (settled) {
			stoppedAt = 'settled';
			break;
		}
	}
	const solution = run.snapshot();
	const workers = run.workers;
	const engine = run.engine;
	t = now();
	run.close();
	const closeMs = now() - t;

	let resolve: CaseResult['resolve'] = null;
	let resolveMs = 0;
	if (c.resolve) {
		const tree = spot.tree;
		const afterCheck = tree.edgeChild[tree.firstEdge[0]];
		const chance = tree.edgeChild[tree.firstEdge[afterCheck]];
		if (spot.board.length === 3 && tree.kind[chance] === NodeKind.Chance) {
			const node = tree.edgeChild[tree.firstEdge[chance]];
			const turn = firstFreeCard(spot.board);
			const board = spot.resolveBoard([...spot.board, turn]).board;
			progress({ phase: 'turn re-solve', iterations: done, ms: now() - started });
			t = now();
			const resolved = resolveSubgame(solution, node, board, {
				player: 0,
				iterations: RESOLVE_ITERATIONS,
				betting: bettingFrom(c.config, tree.round[node]),
				solve: { workers: threads, ...storage },
			});
			resolveMs = now() - t;
			resolve = { turn: formatCards([turn]), iterations: RESOLVE_ITERATIONS, workers: resolved.solution.workers };
		}
	}

	return {
		name: c.name,
		board: c.config.board,
		variant: c.variant,
		mode: c.mode,
		threadsAsked: c.threads,
		threads,
		workers,
		engine,
		estimateBytes: spot.estimate.bytes,
		kept,
		stoppedAt,
		iterations: done,
		ms: {
			threads: threadsMs,
			preset: presetMs,
			build: buildMs,
			alloc: allocMs,
			step: stepMs,
			check: checkMs,
			close: closeMs,
			resolve: resolveMs,
			total: presetMs + buildMs + allocMs + stepMs + checkMs + closeMs,
		},
		checks,
		resolve,
	};
}

/** The lowest card, deuces first, not on `board`: a blank turn on most flops. */
function firstFreeCard(board: readonly number[]): number {
	for (const rank of '23456789TJQKA') {
		for (const suit of 'cdhs') {
			const card = parseCard(`${rank}${suit}`);
			if (!board.includes(card)) return card;
		}
	}
	throw new Error('no card left');
}
