/**
 * Hand classes on every street against the packed exact solve (issue #40).
 *
 *   node --import tsx bench/hand-classes/run.ts monotone [--iterations 300] [--modes exact,flop,board]
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

import { parseArgs } from 'node:util';
import { createRun, defineSpot } from '../../src/index.ts';
import type { Reference } from './classes.ts';
import { buildClasses, tie } from './classes.ts';
import { SPOTS } from './spots.ts';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { iterations: { type: 'string', default: '300' }, modes: { type: 'string', default: 'exact,flop,board' } },
});
const name = positionals[0] ?? 'monotone';
if (!(name in SPOTS)) throw new Error(`unknown spot ${name}; one of ${Object.keys(SPOTS).join(', ')}`);
const total = Number(values.iterations);
if (!Number.isInteger(total) || total < 1) throw new Error(`--iterations must be a positive integer, not ${values.iterations}`);
const modes = values.modes.split(',') as ('exact' | Reference)[];
for (const mode of modes) if (!['exact', 'flop', 'board'].includes(mode)) throw new Error(`unknown mode ${mode}; exact, flop or board`);
// The last iteration is always measured.
const checkpoints = [...new Set([5, 10, 15, 20, 30, 40, 50, 60, 80, 100, 125, 150, 200, 250, 300, 400, 500, total])]
	.filter((i) => i <= total)
	.sort((a, b) => a - b);

const spot = defineSpot(SPOTS[name]);
const rows: Record<string, { iterations: number; percent: number }[]> = {};
const timing: Record<string, { solve: number; tie: number }> = {};

for (const mode of modes) {
	const run = createRun(spot, { workers: 1 });
	try {
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
	} finally {
		run.close();
	}
}

console.log(`\n${name}: exploitability, % of pot (full game, every hand's own cards)`);
console.log(`iters  ${modes.map((m) => m.padStart(8)).join(' ')}`);
for (let r = 0; r < checkpoints.length; r++) {
	console.log(`${String(checkpoints[r]).padStart(5)}  ${modes.map((m) => rows[m][r].percent.toFixed(3).padStart(8)).join(' ')}`);
}
for (const mode of modes) {
	console.log(`${mode}: ${timing[mode].solve.toFixed(1)} ms/iteration solving, ${timing[mode].tie.toFixed(1)} ms tying`);
}
