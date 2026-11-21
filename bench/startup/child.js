/**
 * One process of `bench/startup/measure.ts`: load a built package, then set
 * a spot up and run its first iteration several times, printing the times as
 * JSON. Plain JavaScript run by plain Node, as a caller's code is: under a
 * TypeScript loader every thread a run starts would load it too.
 *
 *   node bench/startup/child.js <dist directory> <case> [repeats] [prepare]
 */

const [dir, name, repeatsArg, prepare] = process.argv.slice(2);
const loadStarted = performance.now();
const { createRun, defineSpot, litePreset } = await import(`${dir}/index.js`);
const load = performance.now() - loadStarted;
if (prepare === 'prepare') await (await import(`${dir}/threads.js`)).enableThreads(4);

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const bench = { pot: 60, stack: 120, oop: OOP, ip: IP };
// Issue #47's betting, which `bench/lite` measures Lite on.
const full = { pot: 55, stack: 975, oop: OOP, ip: IP, betSizes: [[0.33, 0.75, 1.5]], raiseSizes: [[0.75]], maxRaises: 3, allowAllIn: true };
const CASES = {
	river: [{ ...bench, board: 'AsKh7d2c9h', betSizes: [[0.33, 0.75]], maxRaises: 2, allowAllIn: true }, {}, false],
	turn: [{ ...bench, board: 'AsKh7d2c', betSizes: [[0.33, 0.75]], maxRaises: 2 }, {}, false],
	flop: [{ ...bench, board: 'AsKh7d', betSizes: [[0.66]], maxRaises: 1 }, {}, false],
	'flop-4t': [{ ...bench, board: 'AsKh7d', betSizes: [[0.66]], maxRaises: 1 }, { workers: 4 }, false],
	'lite-rainbow-4t': [{ ...full, board: 'AsKh7d' }, { workers: 4 }, true],
	'lite-two-tone-4t': [{ ...full, board: 'Ts9s4h' }, { workers: 4 }, true],
	'lite-monotone-4t': [{ ...full, board: 'Ks9s4s' }, { workers: 4 }, true],
};
if (!(name in CASES)) throw new Error(`case must be one of ${Object.keys(CASES).join(', ')}`);
const [config, options, lite] = CASES[name];
const repeats = Number(repeatsArg ?? 4);

const rows = [];
for (let r = 0; r < repeats; r++) {
	// Another pot each time, as a page solving its next spot would have.
	const mine = { ...config, pot: config.pot + r };
	let started = performance.now();
	const preset = lite ? litePreset(mine, options) : { config: mine, options };
	const spot = defineSpot(preset.config);
	const define = performance.now() - started;
	started = performance.now();
	const run = createRun(spot, preset.options);
	const create = performance.now() - started;
	started = performance.now();
	run.step(1);
	const first = performance.now() - started;
	started = performance.now();
	run.step(1);
	const second = performance.now() - started;
	run.close();
	rows.push({ define, create, first, second });
}
console.log(JSON.stringify({ load, rows }));
