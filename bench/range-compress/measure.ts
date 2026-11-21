/**
 * Issue #156: Lite with and without range compression.
 *
 *   node --import tsx bench/range-compress/measure.ts [board,...] [workers] [tolerance,...]
 *
 * Boards are `bench/blueprint-share/spots.ts`'s (default all three), on issue
 * #47's betting with the bench ranges. `RANGES=<file>` reads two ranges
 * instead, one per line, out of position first, in this package's notation.
 * `BOARD`, `POT` and `STACK` replace the board's cards, the pot and the
 * stack, which is how a spot that starts on the turn or the river is
 * measured (issue #158): `BOARD="Td 9d 6h 2c" POT=91 STACK=957`, with the
 * ranges held there in `RANGES`.
 *
 * For each board it solves `solveLite` as it is, then with `compressRanges`
 * at each tolerance (default 0.005, 0.01, 0.02), on `workers` threads
 * (default 4), and prints: the combinations in play, the blueprint's storage,
 * the iterations to settle, the wall time (the compression included), and
 * how far the root play is from the uncompressed Lite's, as the largest
 * difference in how often the range takes an action at the root and at in
 * position's decision after a check, in percentage points. `again` is the
 * uncompressed Lite solved to half the settle tolerance, to show how much
 * that figure moves between two solves of the same ranges.
 */

import { readFileSync } from 'node:fs';
import { rootPlay, solveLite, storageCost } from '../../src/index.ts';
import type { LiteSolution, SolveLiteOptions, SpotConfig } from '../../src/index.ts';
import { BOARDS, full, type Board } from '../blueprint-share/spots.ts';

const [boardArg, workerArg, toleranceArg] = process.argv.slice(2);
const boards = (boardArg ?? Object.keys(BOARDS).join(',')).split(',') as Board[];
const WORKERS = Number(workerArg ?? 4);
const tolerances = (toleranceArg ?? '0.005,0.01,0.02').split(',').map(Number);
const MiB = 2 ** 20;

/** How often each range takes each action at the root play's decisions. */
function frequencies(lite: LiteSolution): number[][] {
	const play = rootPlay(lite.solution);
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

function run(config: SpotConfig, options: SolveLiteOptions): { lite: LiteSolution; seconds: number } {
	const start = performance.now();
	const lite = solveLite(config, { workers: WORKERS, ...options });
	return { lite, seconds: (performance.now() - start) / 1000 };
}

for (const board of boards) {
	let config = full(board);
	if (process.env.RANGES) {
		const [oop, ip] = readFileSync(process.env.RANGES, 'utf8').split('\n').filter(Boolean);
		config = { ...config, oop, ip };
	}
	if (process.env.BOARD) config = { ...config, board: process.env.BOARD };
	if (process.env.POT) config = { ...config, pot: Number(process.env.POT) };
	if (process.env.STACK) config = { ...config, stack: Number(process.env.STACK) };
	console.log(`\n${process.env.BOARD ? 'given' : board} (${config.board}), ${WORKERS} threads`);
	console.log('variant            combos     storage  iterations   time    root play apart');
	const row = (name: string, result: { lite: LiteSolution; seconds: number }, base?: number[][]): void => {
		const { spot } = result.lite.solution;
		const combos = `${spot.players[0].count}/${spot.players[1].count}`;
		const gap = base ? `${apart(base, frequencies(result.lite)).toFixed(2)} pts` : '';
		console.log(`${name.padEnd(18)} ${combos.padEnd(10)} ${(storageCost(spot, 'f32') / MiB).toFixed(0).padStart(4)} MiB ${String(result.lite.solution.totalIterations).padStart(8)} ${result.seconds.toFixed(1).padStart(8)} s   ${gap}`);
	};
	const plain = run(config, {});
	const base = frequencies(plain.lite);
	row('lite', plain);
	row('again (tighter)', run(config, { settle: { tolerance: 0.005 } }), base);
	for (const tolerance of tolerances) row(`compress ${tolerance}`, run(config, { compressRanges: { tolerance } }), base);
	console.log(`root play of lite: ${base.map((f) => f.map((x) => (100 * x).toFixed(1)).join(' / ')).join('   |   ')}`);
}
