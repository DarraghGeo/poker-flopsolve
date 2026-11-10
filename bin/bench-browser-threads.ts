/**
 * Browser threads benchmark (issue #29).
 *
 * Purpose: measure what the opt-in browser threads (`poker-flopsolve/threads`)
 * buy on flop spots, in a Web Worker in headless Chromium on a cross-origin
 * isolated page, against the same solves single-threaded, and check the
 * threaded answer is exact.
 *
 *   npm run bench:browser:threads
 *   npm run bench:browser:threads -- --spots flop --workers 1,4 --no-reference
 *
 * For each spot it reports:
 * - time and iterations to 0.5% and 0.3% of pot, in the browser at each worker
 *   count, and in Node on one thread;
 * - the baseline the issue sets, a solve stopped at 15 s, at each worker count:
 *   exploitability, and per-combination root EV against a reference solved to
 *   0.1% in Node (range-weighted mean and max absolute error, in % of pot);
 * - whether a fixed-iteration solve is bitwise equal between two browser runs
 *   and to Node, at the same worker count.
 */

import { createRun, defineSpot, solve } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { COMBO_CARDS } from '../src/cards.ts';
import { SPOTS as COMPARE } from '../bench/compare/spots.ts';
import { runInBrowser } from '../scripts/browser-harness.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';

const ALL: Record<string, SpotConfig> = {
	flop: COMPARE.flop,
	monotone: COMPARE.monotone,
	// The README's flop row: 211 vs 203 combos (bin/bench.ts).
	wide: { board: 'AsKh7d', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.66]], maxRaises: 1 },
};

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : undefined;
};
const spotNames = (option('spots') ?? Object.keys(ALL).join(',')).split(',');
const workerList = option('workers')?.split(',').map(Number);
const withReference = !args.includes('--no-reference');
const CAP_MS = Number(option('cap') ?? 15_000);
const FIXED_ITERATIONS = 20;

interface Timed {
	ms: number;
	iterations: number;
	exploitability: number;
}

interface Capped {
	iterations: number;
	exploitability: number;
	ev: [number, number];
	combos: [number[], number[]];
	reach: [number[], number[]];
}

interface Fixed {
	ev: [number, number];
	root: number[];
}

/** The same measurements in Node and in the browser. */
const MEASURE = `
function remainingDeals(config) {
	const cards = config.board.replace(/\\s+/g, '').length / 2;
	let deals = 1;
	for (let card = cards; card < 5; card++) deals *= 52 - card - 4;
	return deals;
}

/** Root EV of every combination a player holds, in chips, and its reach. */
function comboEvs(solution, player, COMBO_CARDS, config) {
	const root = solution.spot.tree.decisionNodes[0];
	const me = solution.reachAt(root, 0, player);
	const opp = solution.reachAt(root, 0, 1 - player);
	const values = solution.solver.valuesAt(root, 0, player, me, opp, solution.solver.rootLive, solution.solver.rootCount);
	const deals = remainingDeals(config);
	const ev = new Array(1326).fill(0);
	for (let c = 0; c < 1326; c++) {
		if (!(me[c] > 0)) continue;
		const a = COMBO_CARDS[2 * c];
		const b = COMBO_CARDS[2 * c + 1];
		let mass = 0;
		for (let o = 0; o < 1326; o++) {
			if (!(opp[o] > 0)) continue;
			const x = COMBO_CARDS[2 * o];
			const y = COMBO_CARDS[2 * o + 1];
			if (x !== a && x !== b && y !== a && y !== b) mass += opp[o];
		}
		ev[c] = mass > 0 ? values[c] / mass / deals : 0;
	}
	return { ev, reach: Array.from(me) };
}

function timeTo(solve, defineSpot, config, workers, target) {
	const started = performance.now();
	const solution = solve(defineSpot(config), { workers, targetPercent: target, iterations: 5000 });
	return { ms: performance.now() - started, iterations: solution.iterations, exploitability: solution.exploitabilityPercent() };
}

function capped(createRun, defineSpot, COMBO_CARDS, config, workers, capMs) {
	const run = createRun(defineSpot(config), { workers });
	try {
		const started = performance.now();
		while (performance.now() - started < capMs) run.step(1);
		const solution = run.snapshot();
		const p0 = comboEvs(solution, 0, COMBO_CARDS, config);
		const p1 = comboEvs(solution, 1, COMBO_CARDS, config);
		return {
			iterations: run.completed,
			exploitability: run.exploitabilityPercent(),
			ev: [solution.evChips(0), solution.evChips(1)],
			combos: [p0.ev, p1.ev],
			reach: [p0.reach, p1.reach],
		};
	} finally {
		run.close();
	}
}

function fixed(createRun, defineSpot, config, workers, iterations) {
	const run = createRun(defineSpot(config), { workers });
	try {
		run.step(iterations);
		const solution = run.snapshot();
		return {
			ev: [solution.evChips(0), solution.evChips(1)],
			root: Array.from(solution.strategyAt(solution.spot.tree.decisionNodes[0], 0).probs),
		};
	} finally {
		run.close();
	}
}
`;

const measure = new Function(`${MEASURE}; return { timeTo, capped, fixed, comboEvs };`)() as {
	timeTo(s: typeof solve, d: typeof defineSpot, config: SpotConfig, workers: number, target: number): Timed;
	capped(c: typeof createRun, d: typeof defineSpot, cards: Uint8Array, config: SpotConfig, workers: number, capMs: number): Capped;
	fixed(c: typeof createRun, d: typeof defineSpot, config: SpotConfig, workers: number, iterations: number): Fixed;
	comboEvs(solution: unknown, player: 0 | 1, cards: Uint8Array, config: SpotConfig): { ev: number[]; reach: number[] };
};

interface BrowserSpot {
	workers: number[];
	to: Record<string, { half: Timed; third: Timed }>;
	capped: Record<string, Capped>;
	fixed: [Fixed, Fixed];
	fixedWorkers: number;
}

interface BrowserOut {
	threads: number;
	reason: string | null;
	hardwareConcurrency: number;
	spots: Record<string, BrowserSpot>;
}

const spots = Object.fromEntries(spotNames.map((name) => [name, ALL[name]]));

console.error('Browser runs (Chromium, cross-origin isolated)...');
const browser = await runInBrowser<BrowserOut>(
	`
	import { createRun, defineSpot, solve } from './src/index.ts';
	import { COMBO_CARDS } from './src/cards.ts';
	import { enableThreads, threadsUnavailable } from './src/threads.ts';
	${MEASURE}
	const SPOTS = ${JSON.stringify(spots)};
	export default async function run() {
		const hardwareConcurrency = navigator.hardwareConcurrency;
		const reason = threadsUnavailable();
		const threads = await enableThreads(hardwareConcurrency);
		const list = ${JSON.stringify(workerList ?? null)} ?? [...new Set([1, 2, 4, hardwareConcurrency])].filter((w) => w <= threads);
		const fixedWorkers = Math.min(4, threads);
		const out = { threads, reason, hardwareConcurrency, spots: {} };
		for (const [name, config] of Object.entries(SPOTS)) {
			const spot = { workers: list, to: {}, capped: {}, fixedWorkers };
			for (const workers of list) {
				spot.to[workers] = {
					half: timeTo(solve, defineSpot, config, workers, 0.5),
					third: timeTo(solve, defineSpot, config, workers, 0.3),
				};
				spot.capped[workers] = capped(createRun, defineSpot, COMBO_CARDS, config, workers, ${CAP_MS});
			}
			spot.fixed = [
				fixed(createRun, defineSpot, config, fixedWorkers, ${FIXED_ITERATIONS}),
				fixed(createRun, defineSpot, config, fixedWorkers, ${FIXED_ITERATIONS}),
			];
			out.spots[name] = spot;
		}
		return out;
	}
	`,
	7_200_000,
	{ isolated: true },
);

console.log(`Browser: ${browser.threads} threads available (hardwareConcurrency ${browser.hardwareConcurrency})` +
	(browser.reason ? `; ${browser.reason}` : ''));

const pct = (chips: number, config: SpotConfig): number => (100 * chips) / config.pot;
const sec = (ms: number): string => (ms / 1000).toFixed(1);

for (const [name, config] of Object.entries(spots)) {
	const there = browser.spots[name];
	console.error(`Node runs for ${name}...`);
	const nodeHalf = measure.timeTo(solve, defineSpot, config, 1, 0.5);
	const nodeThird = measure.timeTo(solve, defineSpot, config, 1, 0.3);
	const nodeFixed = measure.fixed(createRun, defineSpot, config, there.fixedWorkers, FIXED_ITERATIONS);

	console.log(`\n## ${name} (${config.board})`);
	console.log('| Where | Workers | To 0.5%: s (iters) | To 0.3%: s (iters) | Speed-up to 0.3% |');
	console.log('|---|---|---|---|---|');
	console.log(`| Node | 1 | ${sec(nodeHalf.ms)} (${nodeHalf.iterations}) | ${sec(nodeThird.ms)} (${nodeThird.iterations}) | — |`);
	const single = there.to[1]?.third.ms;
	for (const workers of there.workers) {
		const { half, third } = there.to[workers];
		const speedUp = single ? `${(single / third.ms).toFixed(2)}×` : '—';
		console.log(`| Browser | ${workers} | ${sec(half.ms)} (${half.iterations}) | ${sec(third.ms)} (${third.iterations}) | ${speedUp} |`);
	}

	let reference: { ev: number[]; reach: number[] }[] | null = null;
	let referenceEv: [number, number] | null = null;
	if (withReference) {
		console.error(`Reference for ${name} (Node, 4 threads, to 0.1%)...`);
		const solution = solve(defineSpot(config), { workers: 4, targetPercent: 0.1, iterations: 20_000 });
		reference = [0, 1].map((p) => measure.comboEvs(solution, p as 0 | 1, COMBO_CARDS, config));
		referenceEv = [solution.evChips(0), solution.evChips(1)];
		console.log(`\nReference: ${solution.iterations} iterations, ${solution.exploitabilityPercent().toFixed(3)}% of pot.`);
	}

	console.log(`\nStopped at ${CAP_MS / 1000} s in the browser (errors in % of pot; max over combos with reach ≥ 1%):`);
	console.log('| Workers | Iters | Exploitability % | OOP mean / max | IP mean / max | Range EV error OOP / IP |');
	console.log('|---|---|---|---|---|---|');
	for (const workers of there.workers) {
		const run = there.capped[workers];
		const cells: string[] = [];
		const range: string[] = [];
		for (const p of [0, 1] as const) {
			if (!reference || !referenceEv) {
				cells.push('—');
				range.push('—');
				continue;
			}
			let weighted = 0;
			let mass = 0;
			let worst = 0;
			const reach = run.reach[p];
			for (let c = 0; c < 1326; c++) {
				if (!(reach[c] > 0)) continue;
				const error = Math.abs(pct(run.combos[p][c] - reference[p].ev[c], config));
				weighted += reach[c] * error;
				mass += reach[c];
				if (reach[c] >= 0.01) worst = Math.max(worst, error);
			}
			cells.push(`${(weighted / mass).toFixed(3)} / ${worst.toFixed(3)}`);
			range.push(Math.abs(pct(run.ev[p] - referenceEv[p], config)).toFixed(4));
		}
		console.log(`| ${workers} | ${run.iterations} | ${run.exploitability.toFixed(3)} | ${cells[0]} | ${cells[1]} | ${range.join(' / ')} |`);
	}

	const [a, b] = there.fixed;
	const same = (x: Fixed, y: Fixed): boolean =>
		x.ev[0] === y.ev[0] && x.ev[1] === y.ev[1] && x.root.length === y.root.length && x.root.every((v, i) => v === y.root[i]);
	const gap = Math.max(Math.abs(a.ev[0] - nodeFixed.ev[0]), ...a.root.map((v, i) => Math.abs(v - nodeFixed.root[i])));
	console.log(
		`\nBitwise, ${FIXED_ITERATIONS} iterations on ${there.fixedWorkers} workers: browser run to run ${same(a, b) ? 'equal' : 'DIFFERENT'}; ` +
			`browser to Node ${same(a, nodeFixed) ? 'equal' : `differs by up to ${gap.toExponential(2)}`}.`,
	);
}
