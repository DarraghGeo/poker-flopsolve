/**
 * `streetCompression` under Lite: a kept set of hands for every turn and river
 * board, beside `compressRanges` for the flop.
 *
 *   node --import tsx bench/street-compression/measure.ts [board,...] [workers] [passes]
 *
 * Boards are `bench/blueprint-share/spots.ts`'s (default all three), on issue
 * #47's betting with the bench ranges; `RANGES=<file>` reads two ranges
 * instead, one per line, out of position first. `VARIANTS` picks what is
 * solved, `;` between variants and `,` between a variant's streets:
 * `"lite;flop=0.01;river=0.01;turn=0.01,river=0.02;flop=0.01,turn=0.01,river=0.02"`.
 * `flop` is `compressRanges`' tolerance, `turn` and `river` are
 * `streetCompression`'s.
 *
 * Each variant is Lite's blueprint (`litePreset`) run for `passes`
 * iterations (default 200) on `workers` threads (default 4), so the cost of
 * an iteration is compared at the same count. Printed for each: the boards
 * stored, the hands kept on later boards out of those that could be held,
 * the storage, the time to define the spot (which chooses the kept sets),
 * the time for the passes and how many times faster than plain Lite that
 * is, the exploitability in the same tree with every hand on every runout
 * (`trueExploitabilityPercent`; `TRUE=0` skips it), and how far the root
 * play is from plain Lite's, as `bench/range-compress` measures it.
 */

import { readFileSync } from 'node:fs';
import { createRun, defineSpot, litePreset, releaseSetupCache, rootPlay, storageCost } from '../../src/index.ts';
import type { Solution, SolveLiteOptions } from '../../src/index.ts';
import { BOARDS, full, type Board } from '../blueprint-share/spots.ts';

const [boardArg, workerArg, passArg] = process.argv.slice(2);
const boards = (boardArg ?? Object.keys(BOARDS).join(',')).split(',') as Board[];
const WORKERS = Number(workerArg ?? 4);
const PASSES = Number(passArg ?? 200);
const MiB = 2 ** 20;
const variants = (process.env.VARIANTS ?? 'lite;flop=0.01;river=0.005;river=0.01;river=0.02;turn=0.005,river=0.005;turn=0.01,river=0.01;turn=0.01,river=0.02;flop=0.01,river=0.01;flop=0.01,turn=0.01,river=0.02').split(';');

/** How often each range takes each action at the root play's decisions. */
function frequencies(solution: Solution): number[][] {
	const play = rootPlay(solution);
	return play.views.map((view, d) => {
		const actions = view.actions.length;
		const sums = new Array<number>(actions).fill(0);
		let total = 0;
		for (let h = 0; h < view.combos.length; h++) {
			const weight = play.weights[d][view.combos[h]];
			total += weight;
			for (let a = 0; a < actions; a++) sums[a] += weight * view.probs[h * actions + a];
		}
		return sums.map((sum) => sum / total);
	});
}

/** The largest difference between two readings, in percentage points. */
function apart(a: number[][], b: number[][]): number {
	let worst = 0;
	for (let d = 0; d < a.length; d++) for (let i = 0; i < a[d].length; i++) worst = Math.max(worst, Math.abs(a[d][i] - b[d][i]));
	return 100 * worst;
}

function options(variant: string): SolveLiteOptions {
	if (variant === 'lite') return {};
	const streets: Record<string, number> = {};
	for (const part of variant.split(',')) {
		const [street, value] = part.split('=');
		streets[street] = Number(value);
	}
	return {
		...(streets.flop ? { compressRanges: { tolerance: streets.flop } } : {}),
		...(streets.turn || streets.river ? { streetCompression: { ...(streets.turn ? { turn: streets.turn } : {}), ...(streets.river ? { river: streets.river } : {}) } } : {}),
	};
}

for (const board of boards) {
	let config = full(board);
	if (process.env.RANGES) {
		const [oop, ip] = readFileSync(process.env.RANGES, 'utf8').split('\n').filter(Boolean);
		config = { ...config, oop, ip };
	}
	console.log(`\n${board} (${config.board}), ${WORKERS} threads, ${PASSES} passes`);
	console.log('variant                             | combos    | boards    | kept on turns | kept on rivers | storage MiB | define s | passes s | x Lite | exploitable % | root apart');
	let plain: { seconds: number; play: number[][] } | null = null;
	for (const variant of variants) {
		releaseSetupCache();
		const preset = litePreset(config, { workers: WORKERS, settle: false, ...options(variant) });
		const defined = performance.now();
		const spot = defineSpot(preset.config);
		const defineSeconds = (performance.now() - defined) / 1000;
		const run = createRun(spot, preset.options);
		const started = performance.now();
		run.step(PASSES);
		const seconds = (performance.now() - started) / 1000;
		const exploitable = process.env.TRUE === '0' ? NaN : run.trueExploitabilityPercent();
		const play = frequencies(run.snapshot());
		if (variant === 'lite' || plain === null) plain = { seconds, play };
		const kept = spot.kept;
		const share = (round: number): string => {
			const at = spot.runouts.rounds - (3 - round);
			if (!kept || at < 1 || !kept.rounds[at]) return 'all';
			return `${((100 * kept.keptHands[at]) / kept.candidates[at]).toFixed(0)}% of ${(kept.candidates[at] / spot.runouts.counts[at] / 2).toFixed(0)}`;
		};
		console.log([
			variant.padEnd(35), `${spot.players[0].count}/${spot.players[1].count}`.padEnd(9), spot.runouts.counts.slice(1).join('/').padEnd(9),
			share(1).padEnd(13), share(2).padEnd(14), (storageCost(spot, 'f32') / MiB).toFixed(0).padStart(11), defineSeconds.toFixed(2).padStart(8),
			seconds.toFixed(2).padStart(8), (plain.seconds / seconds).toFixed(2).padStart(6), exploitable.toFixed(2).padStart(13), apart(play, plain.play).toFixed(1).padStart(10),
		].join(' | '));
		run.close();
	}
}
