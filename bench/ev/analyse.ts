/**
 * Score EV estimators offline against a logged solve (issue #27).
 *
 *   node --import tsx bench/ev/analyse.ts ev-flop.json [--iterMs 900 --evalMs 500 --browser 1.3]
 *     [--budget 15000] [--lambda 0.25]
 *
 * Reads what bench/ev/log.ts wrote. The reference is the last checkpoint's
 * average-profile EVs. Every error is in % of the pot: the range-weighted
 * mean absolute error over combinations (weighted by range weight times
 * compatible opponent mass, i.e. by how often the combination is dealt), the
 * largest error over combinations weighted at least 1%, and the error of the
 * range-level EV. Each is the mean over the two players.
 *
 * `--iterMs` and `--evalMs` (one average-profile EV pass for both players,
 * single-threaded Node) turn iterations into modelled wall time, and
 * `--browser` is the browser/Node per-iteration ratio. `--budget` is the
 * browser time budget in ms; `--lambda` fixes the blend weight, which the
 * checkpoint table otherwise fits in hindsight and the summaries set to 0.25.
 */

import { readFileSync } from 'node:fs';

interface Checkpoint {
	t: number;
	exploit: number;
	avg: number[][];
	br: number[][];
	cur: number[][];
}
interface Log {
	spot: string;
	pot: number;
	hands: number[][];
	weights: number[][];
	mass: number[][];
	checkpoints: Checkpoint[];
}

const argv = process.argv.slice(2);
const file = argv[0];
const opt = (key: string, fallback: number): number => {
	const at = argv.indexOf(`--${key}`);
	return at >= 0 ? Number(argv[at + 1]) : fallback;
};
const iterMs = opt('iterMs', 1000);
const evalMs = opt('evalMs', 500);
const browser = opt('browser', 1);
const budgetMs = opt('budget', 15000);
const blendFixed = opt('lambda', NaN);

const log: Log = JSON.parse(readFileSync(file, 'utf8'));
const cps = log.checkpoints;
const ref = cps[cps.length - 1];
const players = [0, 1];
const dealt = players.map((p) => log.weights[p].map((w, i) => w * log.mass[p][i]));
const dealtSum = dealt.map((d) => d.reduce((a, b) => a + b, 0));

type Vec = number[][];

interface Score {
	mae: number;
	max: number;
	range: number;
}

function score(estimate: Vec, reference: Vec = ref.avg): Score {
	let mae = 0;
	let max = 0;
	let range = 0;
	for (const p of players) {
		let abs = 0;
		let signed = 0;
		let worst = 0;
		for (let i = 0; i < estimate[p].length; i++) {
			const err = estimate[p][i] - reference[p][i];
			abs += dealt[p][i] * Math.abs(err);
			signed += dealt[p][i] * err;
			if (log.weights[p][i] >= 0.01 && Math.abs(err) > worst) worst = Math.abs(err);
		}
		mae += abs / dealtSum[p];
		range += Math.abs(signed / dealtSum[p]);
		max += worst;
	}
	const pct = 100 / log.pot / 2;
	return { mae: mae * pct, max: max * pct, range: range * pct };
}

const map = (a: Vec, f: (x: number, p: number, i: number) => number): Vec =>
	a.map((row, p) => row.map((x, i) => f(x, p, i)));

/** The checkpoint nearest `t` from below, never the reference; −1 if none. */
function at(t: number): number {
	let best = -1;
	for (let k = 0; k < cps.length - 1; k++) if (cps[k].t <= t) best = k;
	return best;
}

/** avg + λ (br − avg), per hand. */
const blend = (k: number, lambda: number): Vec => map(cps[k].avg, (x, p, i) => x + lambda * (cps[k].br[p][i] - x));

/** Largest extrapolation correction, as a multiple of the last step. */
const MAX_CORRECTION = 3;

/**
 * Richardson-style extrapolation on x(t) = x∞ + C t^−q from three checkpoints
 * near t/r², t/r, t: one exponent q for the whole vector, fitted so the
 * second differences line up with the first in least squares, then each
 * hand's own C. With `perHand`, Aitken's Δ² on each hand's own triple
 * instead, needing no shared q. Either way a correction is capped at
 * MAX_CORRECTION times the hand's last step, and the estimate falls back to
 * the last value where the fit says nothing.
 */
function extrapolate(k: number, r: number, perHand: boolean): Vec {
	const kb = at(cps[k].t / r);
	const ka = at(cps[k].t / (r * r));
	if (!(ka >= 0 && ka < kb && kb < k)) return cps[k].avg;
	const [ta, tb, tk] = [cps[ka].t, cps[kb].t, cps[k].t];
	const xa = cps[ka].avg;
	const xb = cps[kb].avg;
	const xk = cps[k].avg;
	const capped = (x: number, d2: number, correction: number): number =>
		Math.abs(correction) <= MAX_CORRECTION * Math.abs(d2) ? x + correction : x + Math.sign(correction) * MAX_CORRECTION * Math.abs(d2);
	if (perHand) {
		return map(xk, (x, p, i) => {
			const d1 = xb[p][i] - xa[p][i];
			const d2 = x - xb[p][i];
			const ratio = d1 !== 0 ? d2 / d1 : NaN;
			// Converging monotonically: same sign, shrinking.
			if (!(ratio > 0 && ratio < 0.9)) return x;
			return capped(x, d2, (d2 * ratio) / (1 - ratio));
		});
	}
	// Ratio of successive differences, range-weighted.
	let num = 0;
	let den = 0;
	for (const p of players) {
		for (let i = 0; i < xk[p].length; i++) {
			const d1 = xb[p][i] - xa[p][i];
			const d2 = xk[p][i] - xb[p][i];
			num += dealt[p][i] * d1 * d2;
			den += dealt[p][i] * d1 * d1;
		}
	}
	const rho = den > 0 ? num / den : 0;
	// Solve (tk^−q − tb^−q) / (tb^−q − ta^−q) = rho for q by bisection, within
	// exponents a CFR average plausibly shows.
	const ratio = (q: number) => (tk ** -q - tb ** -q) / (tb ** -q - ta ** -q);
	let lo = Q_RANGE[0];
	let hi = Q_RANGE[1];
	if (!(ratio(lo) > rho && ratio(hi) < rho)) return xk;
	for (let n = 0; n < 60; n++) {
		const mid = (lo + hi) / 2;
		if (ratio(mid) > rho) lo = mid;
		else hi = mid;
	}
	const q = (lo + hi) / 2;
	const g = tk ** -q;
	const step = g - tb ** -q;
	return map(xk, (x, p, i) => {
		const d2 = x - xb[p][i];
		return capped(x, d2, -(d2 / step) * g);
	});
}

/** Exponents the vector fit may choose. */
const Q_RANGE = [0.3, 4];

/**
 * EV-stability stopping: checks on a geometric schedule (ratio `growth`), stop
 * once the range-weighted mean change since the previous check is under `eps`
 * % of pot at two checks running. Returns the checkpoint index and checks made.
 */
function stability(eps: number, growth: number): { k: number; checks: number } {
	let prev = -1;
	let calm = 0;
	let checks = 0;
	let t = 1;
	while (true) {
		const k = at(t);
		if (k !== prev) {
			checks++;
			if (prev >= 0) {
				const change = score(cps[k].avg, cps[prev].avg).mae;
				calm = change < eps ? calm + 1 : 0;
				if (calm >= 2) return { k, checks };
			}
			prev = k;
		}
		if (k >= cps.length - 2) return { k: -1, checks };
		t = Math.max(t + 1, Math.ceil(t * growth));
	}
}

const fmt = (s: Score) => `${s.mae.toFixed(3).padStart(7)} ${s.max.toFixed(2).padStart(6)} ${s.range.toFixed(3).padStart(7)}`;
const ms = (t: number, evals: number) => t * iterMs + evals * evalMs;
const seconds = (t: number, evals: number) => ((ms(t, evals) * browser) / 1000).toFixed(1);

console.log(`# ${log.spot}: reference t=${ref.t}, exploitability ${ref.exploit.toFixed(3)}% of pot`);
const ref01 = cps.findIndex((c) => c.exploit <= 0.1);
if (ref01 >= 0) console.log(`  the 0.1% checkpoint (t=${cps[ref01].t}) is off the reference by ${fmt(score(cps[ref01].avg))}`);

// Calibrated blend: λ fitted on this spot, for reporting; --lambda applies one fixed.
function bestLambda(k: number): number {
	let best = 0;
	let err = Infinity;
	for (let l = 0; l <= 1.0001; l += 0.05) {
		const e = score(blend(k, l)).mae;
		if (e < err) [err, best] = [e, l];
	}
	return best;
}

console.log('\nError in % of pot: mae / max / range-EV, at each checkpoint');
console.log('     t  expl%   avg                      current                  midpoint(avg,BR)         blend λ (fitted)          extrap r=1.5 (vec)       aitken r=1.5 (hand)');
for (let k = 0; k < cps.length - 1; k++) {
	const c = cps[k];
	if (k > 12 && k % 2 === 1 && k < cps.length - 4) continue;
	const lambda = Number.isNaN(blendFixed) ? bestLambda(k) : blendFixed;
	console.log(
		`${String(c.t).padStart(6)} ${c.exploit.toFixed(2).padStart(6)}  ${fmt(score(c.avg))}  ${fmt(score(c.cur))}  ${fmt(score(blend(k, 0.5)))}  ${fmt(score(blend(k, lambda)))} λ${lambda.toFixed(2)}  ${fmt(score(extrapolate(k, 1.5, false)))}  ${fmt(score(extrapolate(k, 1.5, true)))}`,
	);
}

// First iteration at which each estimator gets under 1% and 0.5% mean error, and stays there.
const estimators: Record<string, (k: number) => Vec> = {
	avg: (k) => cps[k].avg,
	current: (k) => cps[k].cur,
	'mean(avg,cur)': (k) => map(cps[k].avg, (x, p, i) => (x + cps[k].cur[p][i]) / 2),
	midpoint: (k) => blend(k, 0.5),
	[`blend λ=${Number.isNaN(blendFixed) ? 0.25 : blendFixed}`]: (k) => blend(k, Number.isNaN(blendFixed) ? 0.25 : blendFixed),
	'extrap r=1.5': (k) => extrapolate(k, 1.5, false),
	'extrap r=2': (k) => extrapolate(k, 2, false),
	'aitken r=1.5': (k) => extrapolate(k, 1.5, true),
};
// Evaluation passes each estimator needs at the end (in average-EV passes;
// a best-response pass costs about the same, the current profile likewise).
const evalsNeeded: Record<string, number> = {
	avg: 1, current: 1, 'mean(avg,cur)': 2, midpoint: 2, [`blend λ=${Number.isNaN(blendFixed) ? 0.25 : blendFixed}`]: 2, 'extrap r=1.5': 3, 'extrap r=2': 3, 'aitken r=1.5': 3,
};

console.log(`\nFirst iteration under each mean-error level, staying under after (modelled browser s, ratio ${browser})`);
for (const [name, f] of Object.entries(estimators)) {
	const errs = cps.slice(0, -1).map((_, k) => score(f(k)).mae);
	const first = (level: number) => {
		for (let k = 0; k < errs.length; k++) if (errs.slice(k).every((e) => e < level)) return k;
		return -1;
	};
	const cells = [1, 0.5, 0.25].map((level) => {
		const k = first(level);
		return k < 0 ? '      —      ' : `${String(cps[k].t).padStart(5)} (${seconds(cps[k].t, evalsNeeded[name]).padStart(5)} s)`;
	});
	console.log(`  ${name.padEnd(14)} 1%: ${cells[0]}   0.5%: ${cells[1]}   0.25%: ${cells[2]}`);
}

// Equal-time comparison inside the budget.
const tBudget = (n: number) => Math.floor((budgetMs / browser - n * evalMs) / iterMs);
console.log(`\nAt a ${budgetMs / 1000} s browser budget (iterMs ${iterMs}, evalMs ${evalMs}, ratio ${browser})`);
for (const [name, f] of Object.entries(estimators)) {
	const t = tBudget(evalsNeeded[name]);
	const k = at(t);
	if (k < 0) {
		console.log(`  ${name.padEnd(14)} not affordable`);
		continue;
	}
	console.log(`  ${name.padEnd(14)} t=${String(cps[k].t).padStart(4)}  ${fmt(score(f(k)))}`);
}

console.log('\nEV-stability stopping (checks every ×1.15, two calm checks in a row)');
for (const eps of [0.5, 0.25, 0.1, 0.05, 0.025]) {
	const { k, checks } = stability(eps, 1.15);
	if (k < 0) {
		console.log(`  ε=${String(eps).padEnd(5)} never fired before the reference`);
		continue;
	}
	console.log(`  ε=${String(eps).padEnd(5)} stops t=${String(cps[k].t).padStart(4)} after ${checks} checks, ${seconds(cps[k].t, checks)} s;  error ${fmt(score(cps[k].avg))}, exploitability ${cps[k].exploit.toFixed(3)}%`);
}
