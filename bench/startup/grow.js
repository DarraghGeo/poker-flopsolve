/**
 * A run that grows for the hands a range adds, against one that stores
 * every hand ahead (`oopReserve`, `ipReserve`).
 *
 *   npm run build
 *   node bench/startup/grow.js [workers]
 *
 * On the bench river, turn and flop: a new solve of the range with two hand
 * classes added; then, for a run with no reserve and for one storing every
 * hand, the first solve, the change of range and the re-solve after it, and
 * the change back with its re-solve. Exploitability is checked every five
 * iterations, on the clock.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { createRun, defineSpot } = await import(pathToFileURL(resolve('dist/index.js')).href);
const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const ALL = new Float64Array(1326).fill(1);
const ADD = `${OOP},K8s,76s`;
const workers = Number(process.argv[2] ?? 1);
/** Iterations and milliseconds until exploitability is at or under `target`. */
const to = (run, target, cap = 600) => { const start = run.completed; const s = performance.now(); while (run.completed - start < cap) { run.step(5); if (run.exploitabilityPercent() <= target) break; } return [run.completed - start, performance.now() - s]; };
for (const [name, board, sizes, target] of [['river', 'AsKh7d2c9h', [[0.33, 0.75]], 0.3], ['turn', 'AsKh7d2c', [[0.33, 0.75]], 0.3], ['flop', 'AsKh7d', [[0.66]], 0.5]]) {
	const base = { board, pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: sizes, maxRaises: 1 };
	const cold = createRun(defineSpot({ ...base, oop: ADD }), { workers });
	const [coldIts, coldMs] = to(cold, target); cold.close();
	const row = [];
	for (const [label, extra] of [['grow', {}], ['every hand stored', { oopReserve: ALL, ipReserve: ALL }]]) {
		const run = createRun(defineSpot({ ...base, ...extra }), { workers });
		const [its0, ms0] = to(run, target);
		const before = run.solver;
		let s = performance.now();
		run.setRange(0, ADD);
		const change = performance.now() - s;
		const [its, ms] = to(run, target);
		// And back, which is in place either way.
		s = performance.now(); run.setRange(0, OOP); const back = performance.now() - s;
		const [itsBack, msBack] = to(run, target);
		row.push(`${label}: first solve ${(ms0 / 1000).toFixed(2)} s (${its0} it); add ${change.toFixed(1)} ms${run.solver !== before ? ' (new run)' : ''} then ${(ms / 1000).toFixed(2)} s (${its} it); back ${back.toFixed(2)} ms then ${(msBack / 1000).toFixed(2)} s (${itsBack} it)`);
		run.close();
	}
	console.log(`${name}, ${workers} thread(s), to ${target}%: new solve of the wider range ${(coldMs / 1000).toFixed(2)} s (${coldIts} it)\n  ${row.join('\n  ')}`);
}
