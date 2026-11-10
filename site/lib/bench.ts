/**
 * Benchmark arithmetic for the benchmark page.
 *
 * Purpose: decide when the solve measures its distance from equilibrium, how
 * far along it is, when it will get there, and how the numbers read. Pure,
 * so the worker and the page share it and the tests check it.
 */

/** One exploitability measure taken during a solve. */
export interface Check {
	readonly iterations: number;
	/** Exploitability, % of pot. */
	readonly exploitability: number;
	/** Solving time so far, measures excluded. */
	readonly ms: number;
}

/** When a level of exploitability was first measured; null if never. */
export interface Milestone {
	readonly level: number;
	readonly iterations: number | null;
	readonly ms: number | null;
}

/**
 * Iterations to run before the next measure. Each measure costs about one
 * iteration, so they come every iteration at first and every 15% of the
 * iterations run later: under a tenth of the time, and the target is
 * overshot by at most that much.
 */
export function checkGap(completed: number): number {
	return Math.max(1, Math.floor((completed * 15) / 100));
}

/**
 * How far a solve is from its first measure to the target, 0 to 1, on a log
 * scale: exploitability falls by about the same factor for each doubling of
 * iterations, so this moves steadily.
 */
export function progressToward(first: number, current: number, target: number): number {
	if (current <= target || first <= target) return 1;
	const fraction = Math.log(first / current) / Math.log(first / target);
	return Math.min(1, Math.max(0, fraction));
}

/**
 * Iterations at which exploitability should reach `target`, fitting a power
 * law through the last two measures; null with fewer than two, or if the last
 * did not improve.
 */
export function estimateIterationsTo(checks: readonly Check[], target: number): number | null {
	if (checks.length < 2) return null;
	const a = checks[checks.length - 2];
	const b = checks[checks.length - 1];
	if (b.exploitability <= target) return b.iterations;
	if (!(b.exploitability < a.exploitability) || b.iterations <= a.iterations) return null;
	const slope = Math.log(a.exploitability / b.exploitability) / Math.log(b.iterations / a.iterations);
	return b.iterations * (b.exploitability / target) ** (1 / slope);
}

/** The first measure at or under each level. */
export function milestones(checks: readonly Check[], levels: readonly number[]): Milestone[] {
	return levels.map((level) => {
		const hit = checks.find((check) => check.exploitability <= level);
		return { level, iterations: hit?.iterations ?? null, ms: hit?.ms ?? null };
	});
}

/** A duration for people: "0.42 ms", "12.3 ms", "950 ms", "12.3 s", "2m 05s". */
export function formatMs(ms: number): string {
	if (ms < 1) return `${ms.toFixed(2)} ms`;
	if (ms < 100) return `${ms.toFixed(1)} ms`;
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const seconds = Math.round(ms / 1000);
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** A size for people, in binary units named as most systems name them: "512 B", "3.0 MB", "1.50 GB". */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 2 ** 20) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 2 ** 30) return `${(bytes / 2 ** 20).toFixed(1)} MB`;
	return `${(bytes / 2 ** 30).toFixed(2)} GB`;
}
