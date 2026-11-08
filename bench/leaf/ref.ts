/**
 * Reference solves for the turn-leaf experiment: each measurement spot
 * solved exactly to 0.1% of pot, its per-combo root EV for both players, and
 * the true per-combo EV at every turn leaf (each turn decision that opens a
 * round, on each stored turn card) with the ranges that reach it.
 *
 *   node --import tsx bench/leaf/ref.ts <spot> <outdir> [workers]
 */
import { writeFileSync } from 'node:fs';
import { createRun, defineSpot, formatCards, NodeKind } from '../../src/index.ts';
import { MEASURE } from './spots.ts';
import { comboEv, rowsFor } from './lib.ts';

const [name, outdir, workersArg] = process.argv.slice(2);
const spot = defineSpot(MEASURE[name]);
const run = createRun(spot, { workers: Number(workersArg ?? 4) });
const t0 = performance.now();
let it = 0, e = Infinity;
while (it < 3000) {
	run.step(20);
	it += 20;
	e = run.exploitabilityPercent();
	if (e < 0.1) break;
}
const seconds = (performance.now() - t0) / 1000;
console.log(`${name}: combos ${spot.estimate.combos}, ${it} iterations, ${e.toFixed(3)}% in ${seconds.toFixed(1)} s`);

const sol = run.snapshot();
const { tree, runouts } = spot;
const reach0 = [Float64Array.from(spot.players[0].weights), Float64Array.from(spot.players[1].weights)] as const;
const rootEv = [0, 1].map((p) => Array.from(comboEv(run, 0, 0, p as 0 | 1, reach0[p], reach0[1 - p], spot.board).ev, (v) => (Number.isNaN(v) ? null : v)));
writeFileSync(`${outdir}/ref-${name}.json`, JSON.stringify({ name, combos: spot.estimate.combos, iterations: it, exploit: e, seconds, ev: [sol.ev(0), sol.ev(1)], rootEv, weights: reach0.map((r) => Array.from(r)) }));

// Turn leaves: decisions at round 1 whose parent is a chance node.
const parent = new Int32Array(tree.nodeCount).fill(-1);
for (let n = 0; n < tree.nodeCount; n++) for (let k = 0; k < tree.numEdges[n]; k++) parent[tree.edgeChild[tree.firstEdge[n] + k]] = n;
const leaves: number[] = [];
for (let n = 0; n < tree.nodeCount; n++) if (tree.kind[n] === NodeKind.Decision && tree.round[n] === 1 && tree.kind[parent[n]] === NodeKind.Chance) leaves.push(n);
const lines: string[] = [];
let id = 0;
for (const node of leaves) {
	const pot = tree.pot[node] / spot.chipScale;
	const stack = (spot.stackUnits - (tree.pot[node] - spot.potUnits) / 2) / spot.chipScale;
	for (let b = 0; b < runouts.counts[1]; b++) {
		const cards = Array.from(runouts.cards[1].subarray(b * runouts.width[1], (b + 1) * runouts.width[1]));
		const reach = [sol.reachAt(node, b, 0), sol.reachAt(node, b, 1)] as const;
		if (reach.some((r) => r.reduce((a, x) => a + x, 0) < 1e-6)) continue;
		const ev = [0, 1].map((p) => comboEv(run, node, b, p as 0 | 1, reach[p], reach[1 - p], cards).ev) as [Float64Array, Float64Array];
		const rows = rowsFor(id, cards, pot, stack, reach, ev);
		lines.push(JSON.stringify({ id: id++, label: `${name} ${sol.path(node)} b${b}`, board: formatCards(cards), pot, stack, rows }));
	}
}
writeFileSync(`${outdir}/leaves-${name}.jsonl`, lines.join('\n') + '\n');
console.log(`${name}: ${leaves.length} leaf nodes, ${lines.length} leaf boards`);
run.close();
