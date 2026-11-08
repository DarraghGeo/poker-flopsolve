/**
 * Fit the leaf models on turn-spot rows and report their EV error.
 *
 *   node --import tsx bench/leaf/fit.ts train1.jsonl,train2.jsonl [test.jsonl,...]
 *
 * Without test files, every fifth spot is held out. Errors are in % of the
 * leaf pot: per player, the range-weighted mean absolute error of per-combo
 * EV, the max over combos with weight >= 1%, and the error of the range EV.
 */
import { readFileSync } from 'node:fs';
import type { Row } from './lib.ts';

interface Spot { id: number; pot: number; stack: number; rows: Row[]; label?: string }
const load = (files: string): Spot[] =>
	files.split(',').filter(Boolean).flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Spot));

const [trainArg, testArg] = process.argv.slice(2);
let train = load(trainArg);
let test: Spot[];
if (testArg) test = load(testArg);
else {
	test = train.filter((s) => s.id % 5 === 0);
	train = train.filter((s) => s.id % 5 !== 0);
}

/** A model maps a row to its predicted share of the pot (0..1). */
interface Model { name: string; key: (r: Row) => string; x: (r: Row) => number[]; mult: boolean }
const geo = (r: Row) => `${r.pot}`;
const MODELS: Model[] = [
	{ name: 'equity (R = 1)', key: () => 'all', x: (r) => [r.eq], mult: false },
	{ name: 'opt1: R[made/draw/air] x eq', key: (r) => `${r.cls3}|${r.player}|${geo(r)}`, x: (r) => [r.eq], mult: true },
	{ name: 'opt1: R[6 classes] x eq', key: (r) => `${r.cls6}|${r.player}|${geo(r)}`, x: (r) => [r.eq], mult: true },
	{
		name: 'opt2: cubic in eq + range eq, per 6-class bucket',
		key: (r) => `${r.cls6}|${r.player}|${geo(r)}`,
		x: (r) => [1, r.eq, r.eq ** 2, r.eq ** 3, r.rangeEq, r.eq * r.rangeEq],
		mult: true,
	},
];

function solve(a: number[][], b: number[]): number[] {
	const n = b.length;
	const m = a.map((row, i) => [...row, b[i]]);
	for (let i = 0; i < n; i++) m[i][i] += 1e-9 * (1 + Math.abs(m[i][i]));
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
		[m[c], m[p]] = [m[p], m[c]];
		for (let r = 0; r < n; r++) {
			if (r === c || m[c][c] === 0) continue;
			const f = m[r][c] / m[c][c];
			for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
		}
	}
	return m.map((row, i) => (row[i] === 0 ? 0 : row[n] / row[i]));
}

/** Weighted least squares of share-of-pot on the model's features, per key. */
function fit(model: Model, spots: Spot[]): Map<string, number[]> {
	const acc = new Map<string, { a: number[][]; b: number[] }>();
	for (const s of spots) {
		// Each spot counts equally, whatever its range sizes.
		let total = 0;
		for (const r of s.rows) total += r.w * r.m;
		for (const r of s.rows) {
			const k = model.key(r);
			const x = model.x(r);
			const y = r.ev / r.pot + 0.5;
			const w = (r.w * r.m) / total;
			let e = acc.get(k);
			if (!e) acc.set(k, (e = { a: x.map(() => x.map(() => 0)), b: x.map(() => 0) }));
			for (let i = 0; i < x.length; i++) {
				e.b[i] += w * x[i] * y;
				for (let j = 0; j < x.length; j++) e.a[i][j] += w * x[i] * x[j];
			}
		}
	}
	const out = new Map<string, number[]>();
	for (const [k, e] of acc) out.set(k, model.mult ? solve(e.a, e.b) : [1]);
	return out;
}

function evaluate(model: Model, coef: Map<string, number[]>, spots: Spot[], zeroSum: boolean) {
	const per: { mae: number; max: number; range: number }[][] = [[], []];
	for (const s of spots) {
		const pred = s.rows.map((r) => {
			const c = coef.get(model.key(r));
			const x = model.x(r);
			if (!c) throw new Error(`no fitted bucket ${model.key(r)} for ${model.name}`);
			const share = x.reduce((t, v, i) => t + v * c[i], 0);
			return (share - 0.5) * s.pot;
		});
		// Range EVs, true and predicted, each player's weighted by w * m.
		const sums = [0, 1].map((p) => {
			let w = 0, t = 0, q = 0;
			s.rows.forEach((r, i) => {
				if (r.player !== p) return;
				w += r.w * r.m;
				t += r.w * r.m * r.ev;
				q += r.w * r.m * pred[i];
			});
			return { w, t: t / w, q: q / w };
		});
		// DeepStack's correction: move both players' values by the same amount
		// so that the predicted range EVs sum to zero, as the true ones do.
		const shift = zeroSum ? (sums[0].q + sums[1].q) / 2 : 0;
		for (const p of [0, 1]) {
			let err = 0, max = 0;
			s.rows.forEach((r, i) => {
				if (r.player !== p) return;
				const d = Math.abs(pred[i] - shift - r.ev);
				err += r.w * r.m * d;
				if (r.w >= 0.01) max = Math.max(max, d);
			});
			per[p].push({
				mae: (100 * err) / sums[p].w / s.pot,
				max: (100 * max) / s.pot,
				range: (100 * Math.abs(sums[p].q - shift - sums[p].t)) / s.pot,
			});
		}
	}
	const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
	const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];
	return [0, 1].map((p) => ({
		mae: mean(per[p].map((x) => x.mae)),
		mae90: pct(per[p].map((x) => x.mae), 0.9),
		max: mean(per[p].map((x) => x.max)),
		range: mean(per[p].map((x) => x.range)),
	}));
}

console.log(`train ${train.length} spots (${train.reduce((t, s) => t + s.rows.length, 0)} rows), test ${test.length} spots`);
const f = (x: number) => x.toFixed(2).padStart(6);
console.log('model'.padEnd(52), 'zs', '| OOP mae  p90  max  range | IP mae   p90  max  range  (% of pot)');
for (const model of MODELS) {
	const coef = fit(model, train);
	for (const zs of [false, true]) {
		const [a, b] = evaluate(model, coef, test, zs);
		console.log(model.name.padEnd(52), zs ? 'y ' : 'n ', '|', f(a.mae), f(a.mae90), f(a.max), f(a.range), '|', f(b.mae), f(b.mae90), f(b.max), f(b.range));
	}
	if (model.name.startsWith('opt1') && model.name.includes('made')) {
		console.log('   R by class|player|pot:', [...coef].sort().map(([k, v]) => `${k}=${v[0].toFixed(2)}`).join(' '));
	}
}
