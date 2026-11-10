/**
 * Where a threaded iteration's time goes (issue #133), in Node.
 *
 *   node --import tsx bench/threads/profile.ts [rainbow|two-tone|monotone] [threads,...] [iterations]
 *
 * Solves `solveLite`'s blueprint of issue #47's betting on the board, as
 * `solveLite` sets it up, for 20 warm-up iterations and then `iterations`
 * more, and prints per traversal (two an iteration) what the engine's
 * `profile` counted: the main thread's walk above the split before and
 * after the threads, its wait for them, adding their values, and each
 * thread's own walk of its runouts. Imbalance is the slowest thread's walk
 * over the mean; idle is the share of thread time spent not walking.
 */

import { createRun, defineSpot, litePreset } from '../../src/index.ts';
import { PROFILE, threadProfiles } from '../../src/engine.ts';
import { full, type Board } from '../blueprint-share/spots.ts';

const board = (process.argv[2] ?? 'rainbow') as Board;
const threadList = (process.argv[3] ?? '2,4').split(',').map(Number);
const iterations = Number(process.argv[4] ?? 100);

for (const threads of threadList) {
	const preset = litePreset({ ...full(board), maxBytes: 3.5 * 2 ** 30 }, { workers: threads });
	const run = createRun(defineSpot(preset.config), preset.options);
	try {
		run.step(20);
		const profile = threadProfiles.get(run.solver);
		profile?.fill(0);
		const t = performance.now();
		run.step(iterations);
		const wall = performance.now() - t;
		if (!profile) {
			console.log(`${board}, 1 thread: ${(wall / iterations).toFixed(1)} ms an iteration`);
			continue;
		}
		const n = profile[PROFILE.traversals];
		const per = (slot: number): number => profile[slot] / n;
		const busy = Array.from({ length: run.workers }, (_, w) => per(PROFILE.busy + w));
		const mean = busy.reduce((a, b) => a + b, 0) / busy.length;
		const slowest = Math.max(...busy);
		const traversal = wall / n;
		const serial = per(PROFILE.collect) + per(PROFILE.override) + per(PROFILE.reduce);
		console.log(
			`${board}, ${run.workers} threads: ${(wall / iterations).toFixed(1)} ms an iteration, ${traversal.toFixed(1)} ms a traversal ` +
				`(${n} traversals)\n` +
				`  main thread alone: collect ${per(PROFILE.collect).toFixed(2)}, override ${per(PROFILE.override).toFixed(2)}, ` +
				`reduce ${per(PROFILE.reduce).toFixed(2)} ms = ${((100 * serial) / traversal).toFixed(1)}% of a traversal\n` +
				`  walks: ${busy.map((b) => b.toFixed(1)).join(' / ')} ms; main waits ${per(PROFILE.wait).toFixed(1)} ms; ` +
				`imbalance ${(slowest / mean).toFixed(3)}; idle ${((100 * (1 - (mean + serial / run.workers) / traversal))).toFixed(1)}% of thread time\n` +
				`  engine run ${per(PROFILE.run).toFixed(2)} ms; beyond the main thread's own walk and wait ` +
				`${(per(PROFILE.run) - serial - per(PROFILE.busy) - per(PROFILE.wait)).toFixed(2)} ms; ` +
				`outside the engine ${(traversal - per(PROFILE.run)).toFixed(2)} ms`,
		);
	} finally {
		run.close();
	}
}
