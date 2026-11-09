/**
 * Helpers for test/wasm-storage.test.ts: copy one run's storage into
 * another's, and count where two runs' storage differs.
 */

import type { SolveRun } from '../src/index.ts';

type Numbers = { length: number; [i: number]: number; set(values: ArrayLike<number>): void };

/** Every stored array of a run, by name, in the order both runs list them. */
export function storageArrays(run: SolveRun): [string, Numbers][] {
	const ctx = run.solver.ctx;
	const out: [string, Numbers][] = [
		['regret', ctx.regret as Numbers],
		['strategySum', ctx.strategySum as Numbers],
	];
	if (ctx.regretScale) out.push(['regretScale', ctx.regretScale], ['sumScale', ctx.sumScale!]);
	ctx.compactRegret?.forEach((chunk, c) => out.push([`compactRegret${c}`, chunk as Numbers]));
	ctx.handShift?.forEach((chunk, c) => out.push([`handShift${c}`, chunk]));
	ctx.compactSum?.forEach((chunk, c) => out.push([`compactSum${c}`, chunk]));
	ctx.sumShift?.forEach((chunk, c) => out.push([`sumShift${c}`, chunk]));
	if (ctx.compactScale) out.push(['compactScale', ctx.compactScale]);
	if (ctx.sampling) {
		out.push(['baseline', ctx.sampling.baseline], ['lastWalk', ctx.sampling.lastWalk], ['lastUpdate', ctx.sampling.lastUpdate]);
	}
	if (ctx.discounted) out.push(['discounted', ctx.discounted]);
	return out;
}

/** Copy `from`'s storage into `to`, which must be laid out alike. */
export function copyStorage(to: SolveRun, from: SolveRun): void {
	const source = storageArrays(from);
	const target = storageArrays(to);
	if (source.map(([name]) => name).join() !== target.map(([name]) => name).join()) throw new Error('storage differs in kind');
	target.forEach(([, array], i) => array.set(source[i][1]));
}

/**
 * Per array, the share of values that differ: for integers, any difference;
 * for floats, more than a thousandth of the larger of the two, or of a
 * millionth of the array's largest value where both are smaller.
 */
export function compareStorage(a: SolveRun, b: SolveRun): Map<string, number> {
	const left = storageArrays(a);
	const right = storageArrays(b);
	const out = new Map<string, number>();
	left.forEach(([name, x], i) => {
		const y = right[i][1];
		const float = x instanceof Float32Array || x instanceof Float64Array;
		let largest = 0;
		if (float) for (let k = 0; k < x.length; k++) largest = Math.max(largest, Math.abs(x[k]));
		let differ = 0;
		for (let k = 0; k < x.length; k++) {
			const d = Math.abs(x[k] - y[k]);
			if (float ? d > 1e-3 * Math.max(Math.abs(x[k]), Math.abs(y[k]), 1e-6 * largest) : d !== 0) differ++;
		}
		out.set(name, x.length === 0 ? 0 : differ / x.length);
	});
	return out;
}
