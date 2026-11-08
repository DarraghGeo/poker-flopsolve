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
import { COMBOS } from '../../src/cards.ts';
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
		// The archetype's strategy against the new IP range. A library would store
		// one value per OOP hand per IP hand and take their reweighted average;
		// values are linear in the opponent's reach, so this is that average.
		const oop = comboEvs(archetype, library.solver, 0, custom);
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
