/**
 * A range slider on Lite: `openLite`'s live session against a new
 * `solveLite` for every range, on issue #47's betting.
 *
 *   node --import tsx bench/lite/slider.ts <rainbow|two-tone|monotone> [workers]
 *
 * Out of position's range starts at the bench range and moves five times:
 * two hand classes added (a notch of a slider), all nine (the widest), back
 * to the start, two classes dropped, and a third of the range dropped. The
 * session is opened with the widest range as `oopReserve`. For each move it
 * prints, at `workers` threads (default 4):
 * - `setRange` on the session: seconds and iterations to settle again;
 * - `solveLite` on the new range, as a caller without the session would: the
 *   same;
 * - `solveLite` on the new range with the session's reserve, which separates
 *   what the reserve costs from what starting warm saves;
 * - each one's exploitability in the blueprint's own game (shared
 *   histories, buckets), % of pot: the session's and the last column's are
 *   the same game, the plain `solveLite`'s has the buckets of its own hands;
 * - how far each one's root play is from a reference, the new range's
 *   blueprint (without the reserve) run for `REFERENCE` iterations (default
 *   1000) without the settle stop, two ways, both in percentage points:
 *   the largest difference in how often the range takes an action at the
 *   root or at in position's decision after a check, as
 *   `bench/range-compress` reads it; and per hand, the range-weighted mean
 *   of each hand's total variation, the larger of the two decisions. The
 *   second counts hands trading places between actions they are near
 *   indifferent to, which the first does not.
 *
 * Environment: `RESETTLE` as `every:tolerance:patience` for the session's
 * stop after a move (default `openLite`'s); `REFERENCE=0` skips the
 * references and the distances.
 */

import { openLite, parseRange, rootPlayNodes, solveLite } from '../../src/index.ts';
import type { SettleOptions, Solution, SpotConfig } from '../../src/index.ts';
import { full, type Board } from '../blueprint-share/spots.ts';

const [boardName, workerArg] = process.argv.slice(2) as [Board, string?];
const workers = Number(workerArg ?? 4);
const REFERENCE = Number(process.env.REFERENCE ?? 1000);
const rule = process.env.RESETTLE?.split(':').map(Number);
const resettle: SettleOptions | undefined = rule ? { every: rule[0], tolerance: rule[1], patience: rule[2] } : undefined;

const config = full(boardName);
const BASE = config.oop as string;
const WIDE = `${BASE},K8s-K6s,Q8s,J8s,T8s,76s,65s,A9o-A8o,QJo`;
const TIGHT = 'AA-55,AKs-A7s,KQs-KTs,QJs-QTs,JTs,T9s,AKo-AJo,KQo';
const MOVES = [
	['+2 classes', `${BASE},K8s,76s`],
	['widest', WIDE],
	['back', BASE],
	['-2 classes', BASE.replace(',87s', '').replace('KQo-KJo', 'KQo')],
	['tightest', TIGHT],
] as const;
if (MOVES.some(([, range]) => range !== WIDE && parseRange(range).some((w, combo) => w > 0 && !(parseRange(WIDE)[combo] > 0)))) {
	throw new Error('Every move must stay inside the reserve');
}

/** Root play distance between two solutions of one tree, over the hands of `range`, in points. */
function distance(a: Solution, b: Solution, ranges: readonly [Float64Array, Float64Array]): number {
	let worst = 0;
	for (const node of rootPlayNodes(a)) {
		const [va, vb] = [a.strategyAt(node, 0), b.strategyAt(node, 0)];
		const actions = va.actions.length;
		if (vb.actions.length !== actions) throw new Error('The solutions are of different trees');
		const at = new Map<number, number>();
		vb.combos.forEach((combo, i) => at.set(combo, i));
		const weights = ranges[va.player];
		let moved = 0;
		let mass = 0;
		va.combos.forEach((combo, i) => {
			const w = weights[combo];
			const j = at.get(combo);
			if (!(w > 0) || j === undefined) return;
			let tv = 0;
			for (let k = 0; k < actions; k++) tv += Math.abs(va.probs[i * actions + k] - vb.probs[j * actions + k]);
			moved += (w * tv) / 2;
			mass += w;
		});
		worst = Math.max(worst, moved / mass);
	}
	return 100 * worst;
}

/** How often each range takes each action at the root play's decisions, as `bench/range-compress` reads it. */
function frequencies(solution: Solution): number[][] {
	return rootPlayNodes(solution).map((node) => {
		const view = solution.strategyAt(node, 0);
		const weights = solution.spot.players[view.player].weights;
		const actions = view.actions.length;
		const sums = new Array<number>(actions).fill(0);
		let total = 0;
		view.combos.forEach((combo, h) => {
			total += weights[combo];
			for (let a = 0; a < actions; a++) sums[a] += weights[combo] * view.probs[h * actions + a];
		});
		return sums.map((sum) => sum / total);
	});
}

/** The largest difference between two readings, in percentage points. */
function apart(a: number[][], b: number[][]): number {
	let worst = 0;
	for (let d = 0; d < a.length; d++) for (let i = 0; i < a[d].length; i++) worst = Math.max(worst, Math.abs(a[d][i] - b[d][i]));
	return 100 * worst;
}

const clock = <T>(work: () => T): [T, number] => {
	const started = performance.now();
	const result = work();
	return [result, (performance.now() - started) / 1000];
};
const cell = (seconds: number, iterations: number): string => `${seconds.toFixed(1).padStart(6)} s ${String(iterations).padStart(4)} it`;

console.log(`${boardName} (${config.board}), ${workers} threads${resettle ? `, resettle ${process.env.RESETTLE}` : ''}`);
const reserved: SpotConfig = { ...config, oopReserve: WIDE };
const [session, opened] = clock(() => openLite(reserved, { workers, resettle }));
const [, plain] = clock(() => solveLite(config, { workers }));
console.log(`open     session ${cell(opened, session.iterations)}   solveLite without the reserve ${plain.toFixed(1)} s`);
console.log('move        setRange            solveLite           solveLite+reserve     setRange / solveLite / +reserve: exploitable %      from the reference: range frequencies      per hand');

let total = [0, 0, 0];
for (const [name, range] of MOVES) {
	const before = session.iterations;
	const [warm, warmSeconds] = clock(() => session.setRange(0, range));
	const warmIterations = session.iterations - before;
	const ranges = [parseRange(range), warm.solution.spot.players[1].weights] as const;
	// Best-response passes, off the clock; the session's before anything else can move it.
	const exploitable = [warm.solution.exploitabilityPercent()];
	let quality = '';
	const [cold, coldSeconds] = clock(() => solveLite({ ...config, oop: range }, { workers }));
	const [coldReserve, reserveSeconds] = clock(() => solveLite({ ...reserved, oop: range }, { workers }));
	exploitable.push(cold.solution.exploitabilityPercent(), coldReserve.solution.exploitabilityPercent());
	if (REFERENCE > 0) {
		const long = { workers, settle: false as const, iterations: REFERENCE };
		const reference = solveLite({ ...config, oop: range }, long).solution;
		const d = (s: Solution): string => distance(s, reference, ranges).toFixed(1);
		const base = frequencies(reference);
		const f = (s: Solution): string => apart(frequencies(s), base).toFixed(2);
		quality = `   ${f(warm.solution)} / ${f(cold.solution)} / ${f(coldReserve.solution)}      ${d(warm.solution)} / ${d(cold.solution)} / ${d(coldReserve.solution)}`;
	}
	total = [total[0] + warmSeconds, total[1] + coldSeconds, total[2] + reserveSeconds];
	console.log(
		`${name.padEnd(11)} ${cell(warmSeconds, warmIterations)}   ${cell(coldSeconds, cold.solution.iterations)}   ` +
			`${cell(reserveSeconds, coldReserve.solution.iterations)}   ${exploitable.map((e) => e.toFixed(2)).join(' / ')}${quality}`,
	);
}
console.log(`total       ${total[0].toFixed(1).padStart(6)} s           ${total[1].toFixed(1).padStart(6)} s           ${total[2].toFixed(1).padStart(6)} s`);
session.close();
