/**
 * Coarse-to-fine against a cold solve on the same clock (issue #24).
 *
 *   node --import tsx bench/coarse-to-fine/reference.ts      # once
 *   node --import tsx bench/coarse-to-fine/run.ts flop       # Node, one thread
 *   node --import tsx bench/coarse-to-fine/run.ts flop --browser
 *
 * Prints, per schedule, root-EV error against the reference at each
 * checkpoint: OOP and IP range-weighted mean absolute error, the worst
 * combination, and the range-EV error, all in % of pot.
 */

import { readFileSync } from 'node:fs';
import { runInBrowser } from '../../scripts/browser-harness.ts';
import type { RootEvs, Sample, Schedule } from './measure.ts';
import { timedSolve } from './measure.ts';
import { SPOTS } from './spots.ts';

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--')) ?? 'monotone';
const browser = args.includes('--browser');
const budgetAt = args.indexOf('--budget');
const budget = budgetAt >= 0 ? Number(args[budgetAt + 1]) * 1000 : 15_000;
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? args[onlyAt + 1].split(',') : null;

const config = SPOTS[name];
const reference = (JSON.parse(readFileSync(new URL(`../../scratch/coarse-to-fine/${name}.json`, import.meta.url), 'utf8')) as { evs: RootEvs }).evs;
const checkpoints = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30].map((s) => s * 1000).filter((ms) => ms <= budget);

const SCHEDULES: Schedule[] = [{ name: 'cold' }];
for (const [label, coarse] of [
	['b1', { runoutBuckets: 1 }],
	['b3', { runoutBuckets: 3 }],
	['b3nd', { runoutBuckets: 3, noDonk: true }],
] as const) {
	for (const split of [0.1, 0.25, 0.5, 0.75]) {
		for (const warmIteration of [undefined, 0, 10]) {
			for (const averages of [false, true]) {
				SCHEDULES.push({
					name: `${label} ${Math.round(split * 100)}/${Math.round((1 - split) * 100)} w${warmIteration ?? '='}${averages ? ' avg' : ''}`,
					coarse,
					split,
					warmIteration,
					averages,
				});
			}
		}
	}
}
const chosen = only ? SCHEDULES.filter((s) => only.includes(s.name)) : SCHEDULES;

const results: Record<string, Sample[]> = browser
	? await runInBrowser<Record<string, Sample[]>>(
			`
	import { timedSolve } from './bench/coarse-to-fine/measure.ts';
	export default async function run() {
		const out = {};
		for (const schedule of ${JSON.stringify(chosen)}) {
			out[schedule.name] = timedSolve(${JSON.stringify(config)}, schedule, ${budget}, ${JSON.stringify(checkpoints)}, ${JSON.stringify(reference)});
		}
		return out;
	}
	`,
			3_600_000,
		)
	: Object.fromEntries(chosen.map((s) => [s.name, timedSolve(config, s, budget, checkpoints, reference)]));

const f = (v: number): string => v.toFixed(3);
console.log(`${name} (${browser ? 'browser' : 'node'}, 1 thread): ms stage iters expl% | mae oop/ip | max oop/ip | range oop/ip  (% of pot)`);
for (const [label, samples] of Object.entries(results)) {
	console.log(label);
	for (const s of samples) {
		const [o, i] = s.error;
		console.log(
			`  ${String(s.ms).padStart(6)} ${s.stage.padEnd(6)} ${String(s.iterations).padStart(4)} ${f(s.exploitability).padStart(7)} | ` +
				`${f(o.mae)} ${f(i.mae)} | ${f(o.max)} ${f(i.max)} | ${f(o.range)} ${f(i.range)}`,
		);
	}
}
console.log(`JSON ${JSON.stringify({ name, browser, results })}`);
