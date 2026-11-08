/**
 * Hand classes on every street against the packed exact solve (issue #40).
 *
 *   node --import tsx bench/hand-classes/run.ts monotone [--iterations 300] [--modes exact,flop]
 *
 * Solves the spot three ways, single-threaded in the WebAssembly engine:
 * exact (packed), and with every class's regrets and strategy sums tied
 * after each iteration, for flop-keyed and board-keyed classes (see
 * `classes.ts`). Prints the river vector lengths, then exploitability of
 * the full game at each checkpoint, % of pot. What it found is recorded
 * beside `Approximations` in `src/index.ts`.
 *
 * Tying runs in JavaScript over the engine's storage and is not part of the
 * solve time printed; only the exploitability per iteration is the result.
 */

import { createRun, defineSpot } from '../../src/index.ts';
import type { Reference } from './classes.ts';
import { buildClasses, tie } from './classes.ts';
import { SPOTS } from './spots.ts';

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--')) ?? 'monotone';
const at = args.indexOf('--iterations');
const total = at >= 0 ? Number(args[at + 1]) : 300;
const checkpoints = [5, 10, 15, 20, 30, 40, 50, 60, 80, 100, 125, 150, 200, 250, 300, 400, 500].filter((i) => i <= total);

const spot = defineSpot(SPOTS[name]);
const modesAt = args.indexOf('--modes');
const modes = (modesAt >= 0 ? args[modesAt + 1].split(',') : ['exact', 'flop', 'board']) as ('exact' | Reference)[];
const rows: Record<string, { iterations: number; percent: number }[]> = {};
const timing: Record<string, { solve: number; tie: number }> = {};

for (const mode of modes) {
	const run = createRun(spot, { workers: 1 });
	if (run.engine !== 'wasm') throw new Error('expected the WebAssembly engine');
	const classes = mode === 'exact' ? null : buildClasses(run.solver.ctx, mode);
	if (classes) {
		console.log(`${name} ${mode}: river entries ${classes.riverEntries} -> classes ${classes.riverClasses} (x${(classes.riverEntries / classes.riverClasses).toFixed(2)})`);
	}
	rows[mode] = [];
	let solveMs = 0;
	let tieMs = 0;
	for (let i = 1; i <= total; i++) {
		let t = performance.now();
		run.step(1);
		solveMs += performance.now() - t;
		if (classes) {
			t = performance.now();
			tie(run.solver.ctx, classes);
			tieMs += performance.now() - t;
		}
		if (checkpoints.includes(i)) {
			const percent = run.exploitabilityPercent();
			rows[mode].push({ iterations: i, percent });
			console.log(`  ${mode.padEnd(5)} ${String(i).padStart(4)} ${percent.toFixed(3)}%`);
		}
	}
	timing[mode] = { solve: solveMs / total, tie: tieMs / total };
	run.close();
}

console.log(`\n${name}: exploitability, % of pot (full game, every hand's own cards)`);
console.log(`iters  ${modes.map((m) => m.padStart(8)).join(' ')}`);
for (let r = 0; r < checkpoints.length; r++) {
	console.log(`${String(checkpoints[r]).padStart(5)}  ${modes.map((m) => rows[m][r].percent.toFixed(3).padStart(8)).join(' ')}`);
}
for (const mode of modes) {
	console.log(`${mode}: ${timing[mode].solve.toFixed(1)} ms/iteration solving, ${timing[mode].tie.toFixed(1)} ms tying`);
}
