/**
 * Log root EVs per combination as a solve converges (issue #27).
 *
 *   node --import tsx bench/ev/log.ts --spot flop --workers 4 --target 0.05 --out run.json
 *
 * At each checkpoint on a dense geometric schedule it records, for both
 * players, every combination's root EV under the average profile, its value
 * against a best-responding opponent... more precisely its own best-response
 * value against the opponent's average, and its EV under the current
 * (regret-matched) profile. EVs are in chips; the analysis divides by the pot.
 * The last checkpoint, at `--target` exploitability, is the reference.
 */

import { writeFileSync } from 'node:fs';
import { COMBO_CARDS, COMBOS, createRun, defineSpot } from '../../src/index.ts';
import { Mode } from '../../src/cfr.ts';
import { EV_SPOTS } from './spots.ts';

const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
const name = args.spot ?? 'flop';
const target = Number(args.target ?? 0.1);
const cap = Number(args.cap ?? 3000);
const workers = Number(args.workers ?? 4);

const spot = defineSpot(EV_SPOTS[name]);
const run = createRun(spot, { workers });
const ctx = run.solver.ctx;
const pot = spot.potUnits / spot.chipScale;

// Root hand lists and each hand's compatible opponent mass, which turns a
// counterfactual value into an EV per dealt hand.
const lists = ctx.active;
const rootHands = ([0, 1] as const).map((p) => {
	const slot = p; // round 0, board 0
	const from = lists.start[slot];
	const count = lists.count[slot];
	return Array.from(lists.list.subarray(from, from + count));
});
const mass = ([0, 1] as const).map((p) => {
	const opp = ctx.players[1 - p].weights;
	let total = 0;
	const single = new Float64Array(52);
	for (let c = 0; c < COMBOS; c++) {
		if (!opp[c]) continue;
		total += opp[c];
		single[COMBO_CARDS[c * 2]] += opp[c];
		single[COMBO_CARDS[c * 2 + 1]] += opp[c];
	}
	return rootHands[p].map((c) => total - single[COMBO_CARDS[c * 2]] - single[COMBO_CARDS[c * 2 + 1]] + opp[c]);
});

function evs(mode: Mode, p: 0 | 1, t: number): number[] {
	const values = run.solver.traverseRoot(mode, p, t);
	return rootHands[p].map((_, i) => values[i] / (mass[p][i] * ctx.runoutWeight[0]));
}

interface Checkpoint {
	t: number;
	exploit: number;
	avg: number[][];
	br: number[][];
	cur: number[][];
}

const checkpoints: Checkpoint[] = [];
const started = Date.now();
let t = 0;
let next = 1;
for (;;) {
	run.step(next - t);
	t = next;
	const avg = [evs(Mode.Average, 0, 0), evs(Mode.Average, 1, 0)];
	const br = [evs(Mode.BestResponse, 0, 0), evs(Mode.BestResponse, 1, 0)];
	ctx.applyUpdates = false;
	const cur = [evs(Mode.Train, 0, t + 1), evs(Mode.Train, 1, t + 1)];
	ctx.applyUpdates = true;
	const rangeEv = (v: number[], p: number) =>
		v.reduce((s, x, i) => s + x * ctx.players[p].weights[rootHands[p][i]] * mass[p][i], 0) /
		rootHands[p].reduce((s, c, i) => s + ctx.players[p].weights[c] * mass[p][i], 0);
	const exploit = (100 * (rangeEv(br[0], 0) + rangeEv(br[1], 1)) / 2) / pot;
	checkpoints.push({ t, exploit, avg, br, cur });
	console.log(`${name} t=${t} exploit=${exploit.toFixed(4)}% ev0=${rangeEv(avg[0], 0).toFixed(3)} ${((Date.now() - started) / 1000).toFixed(0)}s`);
	if (exploit <= target || t >= cap) break;
	next = t < 12 ? t + 1 : Math.ceil(t * 1.08);
}
const snap = run.snapshot();
console.log(`check: exploit ${snap.exploitabilityPercent().toFixed(4)}% ev0 ${snap.ev(0).toFixed(3)} ev1 ${snap.ev(1).toFixed(3)}`);
run.close();

writeFileSync(
	args.out ?? `ev-${name}.json`,
	JSON.stringify({
		spot: name,
		pot,
		hands: rootHands,
		weights: rootHands.map((h, p) => h.map((c) => ctx.players[p].weights[c])),
		mass,
		checkpoints,
	}),
);
