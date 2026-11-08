/**
 * Depth-limited solving, measured (issue #21).
 *
 *   node --import tsx bench/depth-limit.ts                 # Node, every spot
 *   node --import tsx bench/depth-limit.ts --browser       # also headless Chromium
 *   node --import tsx bench/depth-limit.ts --spots flop --seconds 15
 *
 * For each spot: an exact reference to 0.1% of pot on 4 threads, cached in
 * scratch/depth-limit/ with its per-combination root EVs; then every variant
 * of `SpotConfig.depthLimit` in bench/depth-limit-lib.ts, and the exact solver
 * stopped by time, single-threaded. Errors are in % of pot against the
 * reference: range-weighted mean absolute per-combination error, the largest
 * over combinations weighted at least 1%, and the range-level EV error.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseCards } from '../src/index.ts';
import { runInBrowser } from '../scripts/browser-harness.ts';
import type { Measured } from './depth-limit-lib.ts';
import { errors, measureBaseline, measureLimited, measureReference, SPOTS, VARIANTS } from './depth-limit-lib.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : fallback;
};
const names = option('spots', Object.keys(SPOTS).join(',')).split(',');
const seconds = Number(option('seconds', '15'));
const target = Number(option('target', '0.1'));
const variants = option('variants', Object.keys(VARIANTS).join(';')).split(';');
const browser = args.includes('--browser');

mkdirSync('scratch/depth-limit', { recursive: true });

const fmt = (pair: readonly number[]): string => pair.map((x) => x.toFixed(2).padStart(5)).join(' / ');

function report(name: string, label: string, where: string, m: Measured, ref: Measured): void {
	const config = SPOTS[name];
	const e = errors(parseCards(config.board), config.pot, m.result, ref.result);
	const classes = Object.entries(e.byClass)
		.map(([kind, pair]) => `${kind} ${fmt(pair)}`)
		.join('  ');
	console.log(
		`${name.padEnd(9)}${label.padEnd(17)}${where.padEnd(8)}${m.seconds.toFixed(1).padStart(6)} s ${String(m.iterations).padStart(5)} it ` +
			`${(m.bytes / 2 ** 20).toFixed(0).padStart(5)} MB  expl ${m.exploitability.toFixed(3).padStart(6)}  ` +
			`MAE ${fmt(e.mae)}  max ${fmt(e.max)}  range ${fmt(e.range)}  | ${classes}`,
	);
}

for (const name of names) {
	const config = SPOTS[name];
	const cache = `scratch/depth-limit/${name}.json`;
	let ref: Measured;
	if (existsSync(cache)) ref = JSON.parse(readFileSync(cache, 'utf8')) as Measured;
	else {
		ref = measureReference(config, target, 4);
		writeFileSync(cache, JSON.stringify(ref));
	}
	console.log(
		`\n${name}: reference ${ref.iterations} iterations, ${ref.seconds.toFixed(1)} s on 4 threads, ` +
			`${ref.exploitability.toFixed(3)}% of pot; range EV ${ref.result.range.map((x) => x.toFixed(3)).join(' / ')} chips`,
	);
	console.log('spot     variant          where      time   iters    mem  exploit(own game)  errors in % of pot, oop / ip');
	report(name, 'exact, by time', 'node', measureBaseline(config, seconds), ref);
	for (const variant of variants) report(name, variant, 'node', measureLimited(config, VARIANTS[variant], target, seconds), ref);

	if (browser) {
		const results = await runInBrowser<Record<string, Measured>>(
			`
			import { measureBaseline, measureLimited, SPOTS, VARIANTS } from './bench/depth-limit-lib.ts';
			export default async function run() {
				const out = {};
				out['exact, by time'] = measureBaseline(SPOTS[${JSON.stringify(name)}], ${seconds});
				for (const variant of ${JSON.stringify(variants)}) {
					out[variant] = measureLimited(SPOTS[${JSON.stringify(name)}], VARIANTS[variant], ${target}, ${seconds});
				}
				return out;
			}
			`,
			3_600_000,
		);
		for (const [label, m] of Object.entries(results)) report(name, label, 'browser', m, ref);
	}
}
