/**
 * Read `bench/library/results/*.json` (from `transfer.ts` and `reweight.ts`) and put every run
 * on the browser's clock: the EV errors each had reached when 15 s of
 * single-threaded browser solving would have run out, using the browser's
 * measured ms per iteration from `browser-speed.ts`.
 *
 *   node --import tsx bench/library/summary.ts flop=387 monotone=155 wide=416
 */

import { existsSync, readFileSync } from 'node:fs';

const BUDGET_MS = 15_000;

interface EvError { mae: number; max: number; range: number }
interface Checkpoint { iterations: number; ms: number; exploitability: number; error: [EvError, EvError] }
interface Trace { label: string; checkpoints: Checkpoint[] }

const msPerIteration: Record<string, number> = {};
for (const arg of process.argv.slice(2)) {
	const [name, ms] = arg.split('=');
	msPerIteration[name] = Number(ms);
}

const cell = (e: EvError): string => `${e.mae.toFixed(2)} / ${e.max.toFixed(1)} / ${e.range.toFixed(2)}`;

for (const [spot, ms] of Object.entries(msPerIteration)) for (const name of [spot, `reweight-${spot}`]) {
	const file = new URL(`./results/${name}.json`, import.meta.url);
	if (!existsSync(file)) continue;
	const { traces } = JSON.parse(readFileSync(file, 'utf8')) as { traces: Trace[] };
	const budget = Math.floor(BUDGET_MS / ms);
	console.log(`\n${name}: ${budget} iterations fit 15 s in the browser (${ms} ms each)`);
	console.log(`${'run'.padEnd(52)}${'iters'.padStart(6)}${'expl %'.padStart(9)}   OOP MAE / max / range     IP MAE / max / range`);
	for (const t of traces) {
		let at = t.checkpoints[0];
		for (const c of t.checkpoints) if (c.iterations <= budget) at = c;
		console.log(`${t.label.padEnd(52)}${String(at.iterations).padStart(6)}${at.exploitability.toFixed(3).padStart(9)}   ${cell(at.error[0]).padEnd(26)}${cell(at.error[1])}`);
	}
}
