/**
 * Issue #101's refinement, measured and not offered: continue a solve with
 * `shareHistories` with chosen lines unshared (`ShareHistories.keepLines`),
 * warm-started from it. The two spots differ only in `keepLines`, so the
 * warm start carries the average strategy too; each unshared node takes its
 * shared block's values.
 */

import { createRun, defineSpot } from '../../src/index.ts';
import type { Solution, SolveOptions, SolveRun, SpotConfig } from '../../src/index.ts';

export function refineLines(
	source: Solution | SolveRun,
	lines: readonly string[],
	options: Omit<SolveOptions, 'warmStart' | 'iterations' | 'targetPercent'> & { iterations: number },
): SolveRun {
	const config = source.spot.source;
	const asked = config.shareHistories;
	if (!asked) throw new Error('refineLines refines a solve with shareHistories');
	const { iterations, ...solve } = options;
	const share = asked === true ? {} : asked;
	const keepLines = [...new Set([...(share.keepLines ?? []), ...lines])];
	const refined: SpotConfig = { ...config, shareHistories: { ...share, keepLines } };
	const run = createRun(defineSpot(refined), { ...solve, warmStart: source });
	try {
		run.step(iterations);
	} catch (error) {
		run.close();
		throw error;
	}
	return run;
}
