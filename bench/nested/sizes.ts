/**
 * Issue #47: how much the blueprint's root size choices cost, judged by the
 * reference's own values. For OOP at the root and IP after a check:
 *
 * - agreement on the best bet size, over all hands and over hands whose
 *   reference preference is clear (best size ahead of the next by ≥ 0.5% of pot);
 * - EV lost by playing the blueprint's strategy there instead of each hand's
 *   best reference action, and, among hands that bet, the size's share of it;
 * - how much of the range has the shove within 1% of pot of its best action.
 *
 *   node --import tsx bench/nested/sizes.ts <rainbow|monotone> <variant...>
 */

import { readFileSync } from 'node:fs';
import { COMBOS, defineSpot, solve } from '../../src/index.ts';
import type { SpotConfig } from '../../src/index.ts';
import { fromJson, rootActionEvs } from './lib.ts';
import { blueprint, target, VARIANTS, type BoardName } from './spots.ts';


const CLEAR = 0.5;
const NEAR = 1;

const [boardName, ...variantNames] = process.argv.slice(2) as [BoardName, ...string[]];
const full = target(boardName);
const REF = new URL(`../../scratch/nested/${boardName}-T/`, import.meta.url);
const reference = JSON.parse(readFileSync(new URL('root.json', REF), 'utf8')) as {
	actions: { player: 0 | 1; actions: string[]; evs: (number | null)[][]; reach: (number | null)[]; probs: (number | null)[][] }[];
};

interface Report {
	decision: string;
	clearShare: number;
	sizeAgreement: number;
	clearAgreement: number;
	loss: { mean: number; max: number };
	sizeLoss: { mean: number; max: number; betShare: number };
	referenceLoss: number;
	shoveNear: number;
	shoveRefProb: number;
	shoveBlueprintProb: number;
}

/** Strategy and values at one decision: probs[action][combo], evs[action][combo] in % of pot. */
function analyse(name: string, actions: readonly string[], refEv: ArrayLike<number>[], refProbs: ArrayLike<number>[], probs: ArrayLike<number>[], reach: ArrayLike<number>): Report {
	const sized = actions.map((a, i) => (a.startsWith('bet') ? i : -1)).filter((i) => i >= 0);
	const shove = actions.indexOf(actions.find((a) => a.startsWith('allin'))!);
	let mass = 0;
	let clearMass = 0;
	let agree = 0;
	let clearAgree = 0;
	let lossSum = 0;
	let lossMax = 0;
	let refLossSum = 0;
	let sizeLossSum = 0;
	let sizeLossMax = 0;
	let betMass = 0;
	let nearMass = 0;
	let shoveRef = 0;
	let shoveBp = 0;
	for (let h = 0; h < COMBOS; h++) {
		const w = reach[h];
		if (!(w > 0) || Number.isNaN(refEv[0][h])) continue;
		mass += w;
		// Whole decision: best reference action against the mix each strategy plays.
		let best = -Infinity;
		for (let a = 0; a < actions.length; a++) best = Math.max(best, refEv[a][h]);
		let played = 0;
		let refPlayed = 0;
		for (let a = 0; a < actions.length; a++) {
			played += (probs[a][h] || 0) * refEv[a][h];
			refPlayed += (refProbs[a][h] || 0) * refEv[a][h];
		}
		const loss = best - played;
		lossSum += w * loss;
		lossMax = Math.max(lossMax, loss);
		refLossSum += w * (best - refPlayed);
		// Sizes: the reference's best and second-best bet, against the blueprint's.
		const order = [...sized].sort((a, b) => refEv[b][h] - refEv[a][h]);
		const gap = refEv[order[0]][h] - refEv[order[1]][h];
		let bpBet = 0;
		let bpBetEv = 0;
		let bpPick = sized[0];
		for (const a of sized) {
			const p = probs[a][h] || 0;
			bpBet += p;
			bpBetEv += p * refEv[a][h];
			if (p > (probs[bpPick][h] || 0)) bpPick = a;
		}
		if (bpBet > 1e-3) {
			const sizeLoss = refEv[order[0]][h] - bpBetEv / bpBet;
			sizeLossSum += w * bpBet * sizeLoss;
			betMass += w * bpBet;
			sizeLossMax = Math.max(sizeLossMax, sizeLoss);
		}
		// Agreement: the blueprint's most-played size against the reference's best.
		const ok = bpBet > 1e-3 ? bpPick === order[0] : false;
		if (bpBet > 1e-3) {
			agree += w * (ok ? 1 : 0);
			if (gap >= CLEAR) {
				clearMass += w;
				clearAgree += w * (ok ? 1 : 0);
			}
		}
		if (refEv[shove][h] >= best - NEAR) nearMass += w;
		shoveRef += w * (refProbs[shove][h] || 0);
		shoveBp += w * (probs[shove][h] || 0);
	}
	let betting = 0;
	for (let h = 0; h < COMBOS; h++) {
		const w = reach[h];
		if (!(w > 0) || Number.isNaN(refEv[0][h])) continue;
		let bpBet = 0;
		for (const a of sized) bpBet += probs[a][h] || 0;
		if (bpBet > 1e-3) betting += w;
	}
	return {
		decision: name,
		clearShare: clearMass / betting,
		sizeAgreement: agree / betting,
		clearAgreement: clearAgree / clearMass,
		loss: { mean: lossSum / mass, max: lossMax },
		sizeLoss: { mean: sizeLossSum / betMass, max: sizeLossMax, betShare: betMass / mass },
		referenceLoss: refLossSum / mass,
		shoveNear: nearMass / mass,
		shoveRefProb: shoveRef / mass,
		shoveBlueprintProb: shoveBp / mass,
	};
}

const out: Record<string, Report[]> = {};
for (const variantName of variantNames) {
	const variant = VARIANTS[variantName];
	if (!variant) throw new Error(`unknown variant ${variantName}`);
	const config: SpotConfig = { ...blueprint(full, variant.later), runoutBuckets: variant.buckets ?? false };
	const bp = solve(defineSpot(config), { workers: 4, targetPercent: 0.3, iterations: 2000, precision: variant.precision });
	const mine = rootActionEvs(bp);
	out[variantName] = mine.map((m, d) => {
		const ref = reference.actions[d];
		if (m.actions.join() !== ref.actions.join()) throw new Error(`root actions differ: ${m.actions} vs ${ref.actions}`);
		return analyse(
			d === 0 ? 'OOP at root' : 'IP after check',
			m.actions,
			ref.evs.map(fromJson),
			ref.probs.map(fromJson),
			m.probs,
			fromJson(ref.reach),
		);
	});
	console.log(`${boardName} ${variantName} (blueprint ${bp.iterations} it, ${bp.exploitabilityPercent().toFixed(3)}%)`);
	for (const r of out[variantName]) {
		console.log(
			`  ${r.decision}: size agreement ${(100 * r.sizeAgreement).toFixed(1)}% of betting hands; ` +
				`clear (gap ≥ ${CLEAR}% pot) ${(100 * r.clearShare).toFixed(1)}% of them, agreement there ${(100 * r.clearAgreement).toFixed(1)}%`,
		);
		console.log(
			`    EV loss of the blueprint's play at reference values: mean ${r.loss.mean.toFixed(3)}% pot, max ${r.loss.max.toFixed(2)}% ` +
				`(the reference's own: ${r.referenceLoss.toFixed(3)}%); size part, per betting hand: mean ${r.sizeLoss.mean.toFixed(3)}%, ` +
				`max ${r.sizeLoss.max.toFixed(2)}% (bets ${(100 * r.sizeLoss.betShare).toFixed(1)}% of the range)`,
		);
		console.log(
			`    shove within ${NEAR}% pot of best: ${(100 * r.shoveNear).toFixed(2)}% of range; shoved by reference ${(100 * r.shoveRefProb).toFixed(3)}%, ` +
				`by blueprint ${(100 * r.shoveBlueprintProb).toFixed(3)}%`,
		);
	}
}
console.log(JSON.stringify(out));
