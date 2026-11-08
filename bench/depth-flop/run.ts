/**
 * Depth-limited flop solving against the exact reference (issue #48).
 *
 *   node --import tsx bench/depth-flop/reference.ts T-rainbow        # once per spot
 *   node --import tsx bench/depth-flop/run.ts T-rainbow [--k 1,2,4] [--refresh 0] [--iterations 300] [--workers 1]
 *
 * For each k: memory at each phase, time per phase, and root-EV error
 * against the reference in % of pot (both players), the per-hand error of
 * each out-of-position root action, and how often the best bet size agrees.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { ContinuationBias } from '../../src/depth.ts';
import { createDepthLimitedRun } from '../../src/depth.ts';
import type { RootReport } from './measure.ts';
import type { Solution } from '../../src/index.ts';
import { evError, nodeEvs, rootReport, sizeReport } from './measure.ts';
import { SPOTS } from './spots.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : fallback;
};
const name = args.find((a) => !a.startsWith('--') && !/^[\d,.]+$/.test(a)) ?? 'T0-rainbow';
const ks = option('k', '1,2,4').split(',').map(Number);
const refreshes = Number(option('refresh', '0'));
const iterations = Number(option('iterations', '300'));
const workers = Number(option('workers', '1'));
const blueprintTarget = Number(option('blueprint-target', '0.3'));
const leafModel = option('model', 'additive') as 'additive' | 'pairs';

const SETS: Record<number, ContinuationBias[]> = {
	1: ['blueprint'],
	2: ['blueprint', 'raise'],
	4: ['blueprint', 'fold', 'call', 'raise'],
};

const config = SPOTS[name];
const refPath = new URL(`../../scratch/depth-flop/${name}.json`, import.meta.url);
const reference = existsSync(refPath) ? (JSON.parse(readFileSync(refPath, 'utf8')) as RootReport) : null;
if (!reference) console.log(`(no reference at ${refPath.pathname}; errors skipped)`);

const mib = (bytes: number): string => `${(bytes / 2 ** 20).toFixed(0)} MiB`;

let blueprintReported = false;
let blueprint: Solution | null = null;
for (const k of ks) {
	let peakRss = 0;
	let peakHeap = 0;
	const sample = (): void => {
		const m = process.memoryUsage();
		peakRss = Math.max(peakRss, m.rss);
		peakHeap = Math.max(peakHeap, m.heapUsed + m.arrayBuffers);
	};
	globalThis.gc?.();
	const started = performance.now();
	const run = createDepthLimitedRun(config, {
		continuations: SETS[k],
		workers,
		blueprintTarget,
		blueprintIterations: 400,
		leafModel,
		onPhase: sample,
		onLeafSpot(_, solution) {
			sample();
			blueprint ??= solution;
		},
	});
	const built = performance.now();
	if (reference && blueprint && !blueprintReported) {
		// The blueprint alone, the one-size game, read at its root: the
		// baseline at about the same memory.
		blueprintReported = true;
		const weights = [run.spot.players[0].weights, run.spot.players[1].weights];
		const errors = ([0, 1] as const).map((p) => evError(nodeEvs(blueprint!.spot, blueprint!.solver, 0, p), reference.evs[p], weights[p]));
		console.log(`blueprint alone: root EV error OOP mae ${errors[0].mae.toFixed(2)} max ${errors[0].max.toFixed(2)}; IP mae ${errors[1].mae.toFixed(2)} max ${errors[1].max.toFixed(2)}`);
	}
	blueprint = null;
	const flopStarted = performance.now();
	const curve: string[] = [];
	for (let r = 0; r <= refreshes; r++) {
		if (r > 0) run.refresh();
		run.step(iterations);
		sample();
		curve.push(`${run.exploitabilityPercent().toFixed(3)}%`);
	}
	const solved = performance.now();
	const totalMs = built - started + (solved - flopStarted);
	const report = rootReport(run.spot, run.solver);
	const r = run.report;
	console.log(
		`\n${name} k=${k}: blueprint ${r.blueprintIterations} it to ${r.blueprintExploitability.toFixed(2)}% in ` +
			`${(r.blueprintMs / 1000).toFixed(1)} s (${mib(r.blueprintBytes)}), ${r.leaves} leaves, tables ` +
			`${(r.tablesMs / 1000).toFixed(1)} s (largest leaf spot ${mib(r.leafBytes)}, kept ${(r.tableBytes / 1024).toFixed(0)} KiB), ` +
			`flop ${((solved - flopStarted) / 1000).toFixed(1)} s for ${(refreshes + 1) * iterations} it; total ${(totalMs / 1000).toFixed(1)} s`,
	);
	console.log(`  peak rss ${mib(peakRss)}, peak heap+buffers ${mib(peakHeap)}; depth-limited exploitability ${curve.join(' → ')}`);
	if (reference) {
		const weights = [run.spot.players[0].weights, run.spot.players[1].weights];
		const errors = ([0, 1] as const).map((p) => evError(report.evs[p], reference.evs[p], weights[p]));
		console.log(`  root EV error, % of pot: OOP mae ${errors[0].mae.toFixed(2)} max ${errors[0].max.toFixed(2)}; IP mae ${errors[1].mae.toFixed(2)} max ${errors[1].max.toFixed(2)}`);
		const sizes = sizeReport(report, reference, weights[0]);
		console.log(
			`  root actions ${report.actions.join(' | ')}: per-hand EV mae ${sizes.actionMae.map((v) => v.toFixed(2)).join(' | ')}; ` +
				`best bet size agrees ${(100 * sizes.sizeAgreement).toFixed(0)}%, best action ${(100 * sizes.actionAgreement).toFixed(0)}%`,
		);
	}
	run.close();
}
process.exit(0);
