/**
 * Issue #103, part 2: solve napkinpoker spots exactly and compare our regrets
 * at the stored nodes with the stored postflop-solver ones.
 *
 *   node --import tsx bench/reference/cross-check.ts <spot id> [target %] [max minutes]
 *
 * 4 threads; f32 when `estimate.bytes` is under 3.5 GiB, else i16. Writes
 * `results/cross-check-<id>.json` and prints a line per scored node.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRun, defineSpot } from '../../src/index.ts';
import { napkinSpots } from './napkinpoker.ts';
import { crossCheck, scoreSolution } from './score.ts';

const [id, targetArg = '0.3', minutesArg = '20'] = process.argv.slice(2);
const target = Number(targetArg);
const deadline = Number(minutesArg) * 60_000;
const napkin = napkinSpots().find((s) => s.id === id);
if (!napkin) throw new Error(`no spot ${id}`);
const spot = defineSpot({ ...napkin.config, maxBytes: 1e13 });
const precision = spot.estimate.bytes < 3.5 * 2 ** 30 ? 'f32' : 'i16';
const run = createRun(spot, { workers: 4, precision });
const start = performance.now();
let expl = Number.POSITIVE_INFINITY;
let step = 20;
while (performance.now() - start < deadline) {
	run.step(step);
	expl = run.exploitabilityPercent();
	console.error(`${id} it ${run.completed} expl ${expl.toFixed(3)}% ${((performance.now() - start) / 1000).toFixed(0)} s`);
	if (expl <= target) break;
	step = expl < 2 * target ? 10 : 20;
}
const seconds = (performance.now() - start) / 1000;
const sol = run.snapshot();
const checks = crossCheck(sol, id);
const score = scoreSolution(sol, id);
run.close();

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const flop = checks.filter((c) => c.street === 'flop');
const turn = checks.filter((c) => c.street === 'turn');
const out = {
	id,
	name: napkin.name,
	board: napkin.config.board,
	potType: napkin.potType,
	precision,
	bytes: spot.estimate.bytes,
	iterations: run.completed,
	exploitability: expl,
	seconds,
	reached: expl <= target,
	summary: {
		flopMeanError: mean(flop.map((c) => c.meanError)),
		flopPlayedError: mean(flop.map((c) => c.playedError)),
		flopWorstPlayed: Math.max(...flop.map((c) => c.playedError)),
		turnPlayedError: mean(turn.map((c) => c.playedError)),
		turnWorstPlayed: Math.max(...turn.map((c) => c.playedError)),
		flopMaxError: Math.max(...flop.map((c) => c.maxError)),
		turnMeanError: mean(turn.map((c) => c.meanError)),
		turnMaxError: Math.max(...turn.map((c) => c.maxError)),
		rootOop: checks.find((c) => c.street === 'flop' && c.path === '') ?? null,
		rootIp: checks.find((c) => c.street === 'flop' && c.path === 'X') ?? null,
		rootLossOop: score.root.oop?.loss ?? null,
		rootLossIp: score.root.ip?.loss ?? null,
		rootRefLossOop: score.root.oop?.refLoss ?? null,
		rootRefLossIp: score.root.ip?.refLoss ?? null,
	},
	checks,
	score,
};
mkdirSync(new URL('results/', import.meta.url), { recursive: true });
writeFileSync(new URL(`results/cross-check-${id}.json`, import.meta.url), JSON.stringify(out, null, '\t'));
for (const c of checks) {
	console.log(
		`${c.id.padEnd(7)} ${c.street} ${c.path.padEnd(16)} reach ${c.reach.map((r) => r.toFixed(2)).join('/')} ` +
			`err mean ${c.meanError.toFixed(3)} played ${c.playedError.toFixed(3)} max ${c.maxError.toFixed(3)} self ${c.selfLoss.toFixed(3)} | ` +
			c.byAction.map((a) => `${a.action} ${a.meanError.toFixed(2)} (${a.ours.toFixed(2)}/${a.stored.toFixed(2)})`).join(' '),
	);
}
console.log(JSON.stringify({ ...out, checks: undefined, score: undefined }));
