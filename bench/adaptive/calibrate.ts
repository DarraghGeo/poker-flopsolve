/**
 * How well a probe predicts what a line is worth (issue #51), on a spot small
 * enough to solve every candidate exactly.
 *
 *   node --import tsx bench/adaptive/calibrate.ts [board] [full] [lines]
 *
 * The true gain of a cut line is what its actor's EV rises by, in % of pot,
 * from the equilibrium of the one-size tree to that of the tree with the
 * line added (both solved to 0.05%). The estimates are those `lineGains`
 * gives after a probe of 20 or 60 iterations. Prints each and their rank
 * correlation; writes `results/calibrate-<board>-<full>.json`.
 */

import { writeFileSync } from 'node:fs';
import { createRun, defineSpot } from '../../src/index.ts';
import { warmStart } from '../../src/warm.ts';
import { baseKept, budgetedConfig, cutsFor, indexFull, lineBytes, lineGains, solveTo } from './grow.ts';
import type { BoardName } from './spots.ts';
import { spotOn } from './spots.ts';
import { TREES } from './trees.ts';

const [board = 'turn', fullName = 'T', count = '24'] = process.argv.slice(2);
const full = indexFull(spotOn(board as BoardName, TREES[fullName]));
const kept = baseKept(full);
const options = { workers: 1 };
const base = solveTo(budgetedConfig(full, kept), 0.05, 4000, options);
const baseEv = [base.run.snapshot().ev(0), base.run.snapshot().ev(1)];
const pot = 55;

// A spread of candidates: every k-th, so all streets and depths appear.
const all = cutsFor(full, kept);
const step = Math.max(1, Math.floor(all.length / Number(count)));
const lines = all.filter((_, i) => i % step === 0).slice(0, Number(count));

const rows: Record<string, unknown>[] = [];
for (const line of lines) {
	const info = full.byPath.get(line)!;
	const actor = full.tree.player[info.parent] as 0 | 1;
	const withIt = new Set(kept).add(line);
	const config = budgetedConfig(full, withIt);
	const exact = solveTo(config, 0.05, 4000, options, base.run, base.run.totalIterations);
	const ev = exact.run.snapshot().ev(actor);
	const truth = (100 * (ev - baseEv[actor])) / pot;
	const estimates: Record<string, number> = {};
	for (const iterations of [20, 60]) {
		const probe = createRun(defineSpot(config), { workers: 1, warmStart: base.run, warmIteration: 10 });
		warmStart(probe.solver.ctx, base.run.solver.ctx, false, undefined, Infinity);
		probe.step(iterations);
		const gain = lineGains(probe, [line])!.get(line)!;
		estimates[`br${iterations}`] = gain.bestResponse;
		estimates[`fo${iterations}`] = gain.firstOrder;
		probe.close();
	}
	// The exact solve's own first-order value, the best a probe could reach.
	estimates.foExact = lineGains(exact.run, [line]).get(line)!.firstOrder;
	exact.run.close();
	const row = { line, round: info.round, kind: info.kind, bytes: lineBytes(full, kept, line), truth, ...estimates };
	rows.push(row);
	console.log(
		`${line.padEnd(56)} truth ${truth.toFixed(4)}  ` +
			Object.entries(estimates).map(([k, v]) => `${k} ${v.toFixed(4)}`).join('  '),
	);
}

/** Spearman rank correlation. */
function spearman(a: number[], b: number[]): number {
	const rank = (v: number[]): number[] => {
		const order = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
		const r = new Array<number>(v.length);
		order.forEach(([, i], k) => (r[i] = k));
		return r;
	};
	const ra = rank(a);
	const rb = rank(b);
	const n = a.length;
	let d = 0;
	for (let i = 0; i < n; i++) d += (ra[i] - rb[i]) ** 2;
	return 1 - (6 * d) / (n * (n * n - 1));
}
const truth = rows.map((r) => r.truth as number);
const summary: Record<string, number> = {};
for (const key of ['br20', 'br60', 'fo20', 'fo60', 'foExact']) {
	summary[key] = spearman(truth, rows.map((r) => r[key] as number));
}
console.log('Spearman rank correlation with the true gain:', summary);
writeFileSync(new URL(`./results/calibrate-${board}-${fullName}.json`, import.meta.url), JSON.stringify({ rows, summary }, null, 1));
base.run.close();
