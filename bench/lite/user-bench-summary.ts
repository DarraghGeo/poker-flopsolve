/**
 * The Lite browser benchmark's results and how they are summarised (issue #133).
 *
 * Purpose: one shape for what `bench/lite/user-bench.ts` measures in a
 * browser, and the arithmetic that turns a set of cases into the table the
 * page and the terminal print: time to settle, cost an iteration, the
 * speed-up and parallel efficiency over the fewest threads run, and the
 * Karp–Flatt serial fraction (the share of an iteration that did not split
 * across threads). No DOM and no Node, so the page, the server and the
 * tests share it.
 */

/** How a case stops: as `solveLite` does (`settle`), or after a fixed number of iterations. */
export type BenchMode = { readonly kind: 'settle' } | { readonly kind: 'fixed'; readonly iterations: number };

/** `solveLite`'s defaults, or its README recipe for better turn re-solves (`keepBudget` 150 MiB at 16 bits). */
export type BenchVariant = 'default' | 'keep';

/** Wall-clock milliseconds of each phase of one case. */
export interface PhaseMs {
	/** `enableThreads`: starting the engine threads, a once-a-page cost. */
	readonly threads: number;
	/** `litePreset`: the blueprint config, and with `keepBudget` the picking solve. */
	readonly preset: number;
	/** `defineSpot`: the tree, runouts and hand lists. */
	readonly build: number;
	/** `createRun`: storage and the engine. */
	readonly alloc: number;
	/** `run.step`: the iterations themselves. */
	readonly step: number;
	/** Snapshots and settle checks between steps. */
	readonly check: number;
	/** `run.close`. */
	readonly close: number;
	/** One turn re-solve, if asked for; 0 otherwise. */
	readonly resolve: number;
	/** What `solveLite` costs a caller: preset, build, alloc, step, check and close. */
	readonly total: number;
}

/** One settle check (or one step, in fixed mode). */
export interface BenchCheck {
	readonly iterations: number;
	/** Milliseconds since the run was created. */
	readonly ms: number;
	/** That step's own milliseconds. */
	readonly stepMs: number;
	/** `rootPlayMovement` at the check; null in fixed mode or at the first check. */
	readonly movement: number | null;
}

/** What one case measured. */
export interface CaseResult {
	/** The spot's name: rainbow, two-tone, monotone or custom. */
	readonly name: string;
	readonly board: string;
	readonly variant: BenchVariant;
	readonly mode: BenchMode;
	readonly threadsAsked: number;
	/** What `enableThreads` granted. */
	readonly threads: number;
	/** `run.workers`: threads the blueprint solve actually used. */
	readonly workers: number;
	readonly engine: string;
	/** `spot.estimate.bytes` of the blueprint. */
	readonly estimateBytes: number;
	/** Lines `keepBudget` kept unshared. */
	readonly kept: readonly string[];
	readonly stoppedAt: 'settled' | 'iterations';
	readonly iterations: number;
	readonly ms: PhaseMs;
	readonly checks: readonly BenchCheck[];
	/** The turn re-solve, if asked for. */
	readonly resolve: { readonly turn: string; readonly iterations: number; readonly workers: number } | null;
}

/** Where the cases ran. */
export interface BenchEnvironment {
	readonly userAgent: string;
	readonly hardwareConcurrency: number;
	/** `navigator.deviceMemory`, GiB, where the browser reports it. */
	readonly deviceMemory: number | null;
	readonly crossOriginIsolated: boolean;
	/** `threadsUnavailable()`: why threads cannot run, or null. */
	readonly threadsUnavailable: string | null;
	readonly simd: boolean;
}

/** Everything a run of the page produced: what is pasted back. */
export interface BenchReport {
	readonly tool: 'poker-flopsolve lite browser bench';
	/** The package version and git commit the page was built from. */
	readonly version: string;
	readonly commit: string;
	readonly startedAt: string;
	readonly environment: BenchEnvironment;
	readonly cases: readonly CaseResult[];
	/** Cases that threw, by label. */
	readonly errors: readonly { readonly label: string; readonly error: string }[];
}

/** One row of the summary. */
export interface SummaryRow {
	readonly name: string;
	readonly variant: BenchVariant;
	readonly mode: string;
	readonly threads: number;
	readonly iterations: number;
	readonly stoppedAt: string;
	/** `ms.total` in seconds: what `solveLite` would take. */
	readonly seconds: number;
	readonly msPerIteration: number;
	/** Share of `ms.total` outside `run.step`: preset (with the pick), build, alloc, checks, close. */
	readonly fixedShare: number;
	/** Per iteration, against the fewest threads of the same spot, variant and mode. */
	readonly speedup: number;
	/** `speedup` over the thread ratio. */
	readonly efficiency: number;
	/** Karp–Flatt serial fraction against that baseline; null at the baseline itself. */
	readonly serialFraction: number | null;
	readonly resolveSeconds: number | null;
}

/** A label for a case. */
export function caseLabel(c: Pick<CaseResult, 'name' | 'variant' | 'mode' | 'threads'>): string {
	return `${c.name} ${c.variant} ${modeLabel(c.mode)} ${c.threads}t`;
}

/** 'settle' or 'fixed N'. */
export function modeLabel(mode: BenchMode): string {
	return mode.kind === 'settle' ? 'settle' : `fixed ${mode.iterations}`;
}

/**
 * The summary rows, grouped by spot, variant and mode, fewest threads first.
 * Speed-ups are per iteration, so a run that settled at a different count
 * still compares; with p the thread ratio, the Karp–Flatt serial fraction
 * is (1/S − 1/p) / (1 − 1/p).
 */
export function summarise(cases: readonly CaseResult[]): SummaryRow[] {
	const groups = new Map<string, CaseResult[]>();
	for (const c of cases) {
		const key = `${c.name}|${c.variant}|${modeLabel(c.mode)}`;
		const group = groups.get(key) ?? [];
		group.push(c);
		groups.set(key, group);
	}
	const rows: SummaryRow[] = [];
	for (const group of groups.values()) {
		group.sort((a, b) => a.workers - b.workers);
		const base = group[0];
		const baseMs = perIteration(base);
		for (const c of group) {
			const ms = perIteration(c);
			const speedup = baseMs / ms;
			const p = c.workers / base.workers;
			rows.push({
				name: c.name,
				variant: c.variant,
				mode: modeLabel(c.mode),
				threads: c.workers,
				iterations: c.iterations,
				stoppedAt: c.stoppedAt,
				seconds: c.ms.total / 1000,
				msPerIteration: ms,
				fixedShare: c.ms.total > 0 ? (c.ms.total - c.ms.step) / c.ms.total : 0,
				speedup,
				efficiency: speedup / p,
				serialFraction: p > 1 ? (1 / speedup - 1 / p) / (1 - 1 / p) : null,
				resolveSeconds: c.resolve ? c.ms.resolve / 1000 : null,
			});
		}
	}
	return rows;
}

/** Milliseconds of `run.step` an iteration. */
function perIteration(c: CaseResult): number {
	return c.iterations > 0 ? c.ms.step / c.iterations : Number.NaN;
}

/** The summary as a plain-text table. */
export function formatSummary(rows: readonly SummaryRow[]): string {
	const head = ['spot', 'variant', 'mode', 'threads', 'iters', 'stop', 'total s', 'ms/iter', 'fixed', 'speed-up', 'efficiency', 'serial', 're-solve s'];
	const fixed = (v: number, digits: number): string => (Number.isFinite(v) ? v.toFixed(digits) : '-');
	const percent = (v: number): string => (Number.isFinite(v) ? `${(100 * v).toFixed(0)}%` : '-');
	const body = rows.map((r) => [
		r.name, r.variant, r.mode, String(r.threads), String(r.iterations), r.stoppedAt,
		fixed(r.seconds, 1), fixed(r.msPerIteration, 0), percent(r.fixedShare), `${fixed(r.speedup, 2)}x`, percent(r.efficiency),
		r.serialFraction === null ? '-' : percent(r.serialFraction), r.resolveSeconds === null ? '-' : fixed(r.resolveSeconds, 1),
	]);
	const all = [head, ...body];
	const widths = head.map((_, i) => Math.max(...all.map((row) => row[i].length)));
	return all.map((row) => row.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ')).join('\n');
}
