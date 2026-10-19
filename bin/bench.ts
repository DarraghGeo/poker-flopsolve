/**
 * Solver benchmark.
 *
 * Purpose: one fixed set of spots, timed the same way every time, so a change
 * to the solver is judged by numbers rather than by feel.
 *
 *   npm run bench                        # every spot, single-threaded
 *   npm run bench -- --spots turn,flop --workers 4
 *   npm run bench -- --algorithm dcfr --iters 400
 *
 * For each spot it reports the cost of one iteration, the cost of one
 * exploitability check, and how many iterations it took to reach 1% and 0.3%
 * of the pot. Crossings are found by checking on a 15% geometric schedule, so
 * they are upper bounds accurate to that step; the schedule is the same for
 * every run, which is what makes runs comparable.
 */

import { createRun, defineSpot } from '../src/index.ts';
import type { SolveOptions, SpotConfig } from '../src/index.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';

const SPOTS: Record<string, SpotConfig> = {
	river: { board: 'AsKh7d2c9h', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.33, 0.75]], maxRaises: 2, allowAllIn: true },
	turn: { board: 'AsKh7d2c', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.33, 0.75]], maxRaises: 2 },
	flop: { board: 'AsKh7d', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.66]], maxRaises: 1 },
	twotone: { board: 'Ts9s4h', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.66]], maxRaises: 1 },
};

/** Targets reported, as a percentage of the pot. */
const TARGETS = [1, 0.3];

/** Growth between exploitability checks. */
const CHECK_GROWTH = 1.15;

function parseArgs(argv: readonly string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith('--')) continue;
		const next = argv[i + 1];
		args[argv[i].slice(2)] = next && !next.startsWith('--') ? (i++, next) : 'true';
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
const names = (args.spots ?? Object.keys(SPOTS).join(',')).split(',');
const workers = args.workers === undefined ? 1 : args.workers === 'auto' ? 'auto' : Number(args.workers);
const cap = Number(args.iters ?? 1000);
const timed = Number(args.timed ?? 5);
const options: SolveOptions = {
	workers,
	precision: args.precision === 'f64' ? 'f64' : args.precision === 'f32' ? 'f32' : undefined,
	algorithm: args.algorithm === 'cfr+' ? 'cfr+' : 'dcfr',
};

console.log(`algorithm ${options.algorithm}`);
console.log(
	`spot      MB    workers  ms/iter   check ms  ` + TARGETS.map((t) => `iters→${t}%  s→${t}%`.padEnd(20)).join(''),
);

for (const name of names) {
	const config = SPOTS[name];
	if (!config) throw new Error(`Unknown spot "${name}"; pick from ${Object.keys(SPOTS).join(', ')}`);
	const spot = defineSpot(config);
	const run = createRun(spot, options);
	try {
		// Per-iteration cost, measured early: a few warm-up iterations first so
		// the JIT has settled, then a timed block.
		let started = performance.now();
		run.step(2);
		let solving = performance.now() - started;
		started = performance.now();
		run.step(timed);
		const block = performance.now() - started;
		const perIteration = block / timed;
		solving += block;

		started = performance.now();
		run.exploitabilityPercent();
		const perCheck = performance.now() - started;

		// Iterations to each target, timing only the stepping.
		const reached = new Map<number, { iterations: number; seconds: number }>();
		while (run.completed < cap && reached.size < TARGETS.length) {
			const next = Math.min(cap, Math.max(run.completed + 1, Math.ceil(run.completed * CHECK_GROWTH)));
			started = performance.now();
			run.step(next - run.completed);
			solving += performance.now() - started;
			const percent = run.exploitabilityPercent();
			for (const target of TARGETS) {
				if (!reached.has(target) && percent <= target) {
					reached.set(target, { iterations: run.completed, seconds: solving / 1000 });
				}
			}
		}

		const cells = TARGETS.map((target) => {
			const hit = reached.get(target);
			return (hit ? `${String(hit.iterations).padStart(8)}  ${hit.seconds.toFixed(1).padStart(7)}` : `   >${cap}`.padEnd(17)).padEnd(20);
		});
		console.log(
			`${name.padEnd(8)}${(spot.estimate.bytes / 1048576).toFixed(0).padStart(5)}  ${String(run.workers).padStart(7)}` +
				`${perIteration.toFixed(1).padStart(10)}${perCheck.toFixed(1).padStart(11)}  ${cells.join('')}`,
		);
	} finally {
		run.close();
	}
}
