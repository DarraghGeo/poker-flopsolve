/**
 * Issue #102: a combination of memory levers on napkinpoker's reference
 * spots (#87), for texture coverage.
 *
 *   node --import tsx bench/combos/napkin.ts <combination> [iterations] [spot ids]
 *
 * Each spot is solved with the combination (`spots.ts`) on 4 threads for
 * `iterations` (default 300), then OOP's play at the root and IP's after a
 * check are valued at the stored postflop-solver EVs: each hand's best stored
 * action minus the stored EV of the mix this solve plays, weighted by the
 * hand's stored reach, % of pot. Stored EVs are relative to the node, but
 * differences between one hand's actions are exact (see the fixtures'
 * README), so this loss is too. Their 0.3% of pot precision bounds what it
 * can resolve. The stored solver's own play is scored the same way.
 *
 * Writes `out/napkin-<combination>.json`.
 */

import { writeFileSync } from 'node:fs';
import { createRun, defineSpot } from '../../src/index.ts';
import type { Solution } from '../../src/index.ts';
import { matchLabel, napkinNodes, napkinSpots, nodeAt } from '../reference/napkinpoker.ts';
import type { NapkinNode } from '../reference/napkinpoker.ts';
import { combination } from './spots.ts';

const DEFAULT_SPOTS = ['f06', 'f15', 'f20', 'f02', 'f42', 'f00', 'f85'];
const [comboName, iterArg, spotArg] = process.argv.slice(2);
const iterations = Number(iterArg ?? 300);
const ids = spotArg ? spotArg.split(',') : DEFAULT_SPOTS;
const { config: levers, options } = combination(comboName);
const stored = napkinNodes('flop');

/** Loss of `probs` (per stored action, per stored combination index) at stored values, % of pot. */
function loss(node: NapkinNode, probs: Float64Array[]): number {
	let sum = 0;
	let mass = 0;
	for (let i = 0; i < node.combos.length; i++) {
		const w = node.weight[i];
		if (!(w > 0)) continue;
		let best = -Infinity;
		let played = 0;
		let skip = false;
		for (let a = 0; a < node.actions.length; a++) {
			const ev = node.ev[a][i];
			if (Number.isNaN(ev)) {
				if (probs[a][i] > 0) skip = true;
				continue;
			}
			best = Math.max(best, ev);
			played += probs[a][i] * ev;
		}
		if (skip || best === -Infinity) continue;
		sum += w * (best - played);
		mass += w;
	}
	return (100 * sum) / mass / node.pot;
}

/** This solve's strategy at the stored node, laid out as the stored one. */
function mine(sol: Solution, node: NapkinNode): Float64Array[] {
	const match = nodeAt(sol.spot, node.path);
	const view = sol.strategyAt(match.node, 0);
	const row = new Map<number, number>();
	for (let i = 0; i < view.combos.length; i++) row.set(view.combos[i], i);
	const out = node.actions.map(() => new Float64Array(node.combos.length));
	for (let a = 0; a < match.labels.length; a++) {
		const s = matchLabel(node.actions, match.labels[a]);
		if (s < 0) throw new Error(`${node.id}: action ${match.labels[a]} not stored (${node.actions.join(', ')})`);
		for (let i = 0; i < node.combos.length; i++) {
			const r = row.get(node.combos[i]);
			if (r !== undefined) out[s][i] = view.probs[r * view.actions.length + a];
		}
	}
	return out;
}

const results: Record<string, unknown>[] = [];
for (const napkin of napkinSpots().filter((s) => ids.includes(s.id))) {
	const spot = defineSpot({ ...napkin.config, ...levers, maxBytes: 2 ** 40 });
	const started = performance.now();
	const run = createRun(spot, { ...options, workers: 4 });
	run.step(iterations);
	const seconds = (performance.now() - started) / 1000;
	const exploitability = run.exploitabilityPercent();
	const sol = run.snapshot();
	const decisions = [[], ['X']].map((path) => {
		const node = stored.find((n) => n.spot === napkin.id && n.path.join() === path.join());
		if (!node) throw new Error(`${napkin.id}: no stored node at ${path}`);
		return {
			at: path.length === 0 ? 'OOP root' : 'IP after check',
			loss: +loss(node, mine(sol, node)).toFixed(4),
			storedOwn: +loss(node, node.strategy).toFixed(4),
		};
	});
	run.close();
	const row = {
		id: napkin.id, name: napkin.name, engine: run.engine,
		storageMiB: +(spot.estimate.bytes / 2 ** 20).toFixed(1), seconds: +seconds.toFixed(1),
		exploitability: +exploitability.toFixed(3), decisions,
	};
	results.push(row);
	console.log(JSON.stringify(row));
}
writeFileSync(new URL(`./out/napkin-${comboName}.json`, import.meta.url), JSON.stringify({ combination: comboName, iterations, results }, null, 1));
