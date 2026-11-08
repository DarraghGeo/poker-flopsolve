/**
 * Flop-library experiment (#30), the other way to serve a custom range:
 * re-weighting stored per-matchup values instead of solving.
 *
 *   node --import tsx bench/library/reweight.ts [spot ...]
 *
 * The library holds, for its archetype ranges, each OOP hand's root value
 * against each IP hand alone under the archetype equilibrium. When IP's range
 * is reweighted (only hands the archetype has), OOP's EV per hand is the
 * reweighted average of those values; IP's per-hand EVs, against the same
 * OOP range, are the archetype's own. Neither side's strategy adapts to the
 * new range, which is the error this measures, against a 0.1% reference of
 * the custom spot, beside a cold solve of it checked every few iterations,
 * and solves warm-started from the archetype's solve of the same flop.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRun, defineSpot, solve } from '../../src/index.ts';
import type { Spot } from '../../src/index.ts';
import { COMBO_CARDS, COMBOS } from '../../src/cards.ts';
import { SPOTS as COMPARE } from '../compare/spots.ts';
import type { ComboEv, Trace } from './measure.ts';
import { comboEvs, evError, fmt, forget, trace } from './measure.ts';

const THREADS = 4;

/** IP ranges a user might bring, each a reweighting or subset of the archetype's. */
const CUSTOM: Record<string, string> = {
	'small pairs and offsuit halved': 'TT-77,66-22:0.3,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo:0.5,KQo:0.5',
	'pairs and broadway': 'TT-22,AQs-ATs,KQs-KTs,QJs-QTs,JTs,AQo-ATo,KQo',
};

const BOARDS: Record<string, string> = { flop: COMPARE.flop.board, monotone: COMPARE.monotone.board };

/**
 * OOP's root EV per hand against a reweighted IP range, under the archetype's
 * strategy. A library would store one value per OOP hand per IP hand and take
 * the reweighted average; values are linear in the opponent's reach, so one
 * `valuesAt` with the new weights is exactly that average, without the table.
 * (`pairValuesAt`, which would build the table, is only exact at nodes where
 * its traverser acts after a bet: see #42.)
 */
function reweighted(archetype: Spot, solver: ReturnType<typeof solve>['solver'], custom: Spot): ComboEv {
	const oop = archetype.players[0];
	const me = new Float64Array(COMBOS);
	const opp = new Float64Array(COMBOS);
	for (let i = 0; i < oop.count; i++) me[oop.combos[i]] = oop.weights[oop.combos[i]];
	const ip = custom.players[1];
	for (let i = 0; i < ip.count; i++) opp[ip.combos[i]] = ip.weights[ip.combos[i]];
	const values = solver.valuesAt(0, 0, 0, me, opp, solver.rootLive, solver.rootCount);
	const runoutWeight = solver.ctx.runoutWeight[0];
	const ev = new Float64Array(COMBOS).fill(Number.NaN);
	const mass = new Float64Array(COMBOS);
	const weight = new Float64Array(COMBOS);
	let total = 0;
	let totalMass = 0;
	for (let i = 0; i < oop.count; i++) {
		const combo = oop.combos[i];
		const a = COMBO_CARDS[combo * 2];
		const b = COMBO_CARDS[combo * 2 + 1];
		let facing = 0;
		for (let j = 0; j < ip.count; j++) {
			const h = ip.combos[j];
			const c = COMBO_CARDS[h * 2];
			const d = COMBO_CARDS[h * 2 + 1];
			if (c !== a && c !== b && d !== a && d !== b) facing += opp[h];
		}
		if (facing <= 0) continue;
		ev[combo] = values[combo] / (facing * runoutWeight);
		weight[combo] = me[combo];
		mass[combo] = weight[combo] * facing;
		total += mass[combo] * ev[combo];
		totalMass += mass[combo];
	}
	return { ev, mass, weight, rangeEv: total / totalMass };
}

const wanted = process.argv.slice(2);
for (const [name, board] of Object.entries(BOARDS)) {
	if (wanted.length > 0 && !wanted.includes(name)) continue;
	const config = name === 'flop' ? COMPARE.flop : COMPARE.monotone;
	const archetype = defineSpot(config);
	const library = solve(archetype, { targetPercent: 0.1, iterations: 3000, workers: THREADS });
	console.log(`\n== ${name}: ${board}, archetype solved to ${library.exploitabilityPercent().toFixed(3)}%`);
	const archetypeIp = comboEvs(archetype, library.solver, 1);
	const traces: Trace[] = [];
	const reweights: unknown[] = [];

	for (const [label, ip] of Object.entries(CUSTOM)) {
		const custom = defineSpot({ ...config, ip });
		const reference = solve(custom, { targetPercent: 0.1, iterations: 3000, workers: THREADS });
		const referenceEvs: [ComboEv, ComboEv] = [comboEvs(custom, reference.solver, 0), comboEvs(custom, reference.solver, 1)];

		const started = performance.now();
		const oop = reweighted(archetype, library.solver, custom);
		const precomputeMs = performance.now() - started;
		// IP's hands face the same OOP range, so the archetype's own values stand.
		const ipEv: ComboEv = { ...archetypeIp, mass: referenceEvs[1].mass, weight: referenceEvs[1].weight };
		let total = 0;
		let mass = 0;
		for (let combo = 0; combo < COMBOS; combo++) {
			if (!(ipEv.mass[combo] > 0)) continue;
			total += ipEv.mass[combo] * ipEv.ev[combo];
			mass += ipEv.mass[combo];
		}
		const ipEstimate: ComboEv = { ...ipEv, rangeEv: total / mass };

		console.log(`\n-- custom IP: ${label} (${custom.players[1].count} combos); per-matchup table ${archetype.players[0].count} x ${archetype.players[1].count}, evaluated in ${(precomputeMs / 1000).toFixed(1)} s`);
		const errors = [evError(oop, referenceEvs[0], config.pot), evError(ipEstimate, referenceEvs[1], config.pot)];
		reweights.push({ custom: label, ip, error: errors, precomputeMs });
		console.log(`  reweighted   OOP ${fmt(errors[0])}   IP ${fmt(errors[1])}   (MAE / max / range, % pot)`);
		const at = traces.length;
		traces.push(trace('cold', custom, () => createRun(custom, { workers: 1 }), referenceEvs, config.pot));
		// Or warm from the archetype's solve of the same flop, seeded as far as
		// a library could ship (see transfer.ts): every street as the upper
		// bound, then the flop's decisions only.
		for (const variant of [
			{ label: 'warm all streets', keep: 3 },
			{ label: 'warm flop+turn', keep: 2 },
			{ label: 'warm flop only', keep: 1 },
			{ label: 'warm flop only t=10', keep: 1, warmIteration: 10 },
		]) {
			traces.push(trace(
				variant.label,
				custom,
				() => {
					const run = createRun(custom, { workers: 1, warmStart: library, warmIteration: variant.warmIteration });
					forget(run.solver.ctx, variant.keep);
					return run;
				},
				referenceEvs,
				config.pot,
			));
		}
		for (const t of traces.slice(at)) t.label = `${label}: ${t.label}`;
	}
	mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
	writeFileSync(new URL(`./results/reweight-${name}.json`, import.meta.url), JSON.stringify({ config, reweights, traces }, null, 1));
}
