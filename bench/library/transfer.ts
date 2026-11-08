/**
 * Flop-library feasibility experiment (#30): what does a solve of a nearby
 * flop buy for a different one?
 *
 *   node --import tsx bench/library/transfer.ts [spot ...]
 *
 * For each target spot and each neighbour flop a library might hold:
 *
 * - The reference: the target solved to 0.1% of pot on every core.
 * - The library entry: the neighbour solved to 0.1% the same way.
 * - At t = 0, the root EV of every combination three ways: the neighbour's
 *   per-combo EVs relabelled (a pure lookup); the neighbour's average strategy
 *   relabelled and evaluated in the target game; and its regrets relabelled
 *   (the current strategy a warm start begins from), evaluated the same way.
 * - Then single-threaded solving, cold and warm from the neighbour, checked
 *   every few iterations: iterations and time to 1%, 0.5% and 0.3%, and the
 *   EV errors along the way, so equal-time comparisons can be read off
 *   (`summary.ts` does, on the browser's clock). Warm runs are seeded from
 *   every street (an upper bound: no library could ship that), from the flop
 *   and turn decisions only, or from the flop's only.
 *
 * EV errors are against the reference, in % of pot, per player: the
 * range-weighted mean absolute error per combination, the largest error over
 * combinations with at least 1% reach, and the error of the range EV.
 *
 * Results go to stdout as a table and to `bench/library/results/<spot>.json`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRun, defineSpot, solve } from '../../src/index.ts';
import { COMBOS, parseCards } from '../../src/cards.ts';
import { warmStart } from '../../src/warm.ts';
import type { ComboEv, Trace } from './measure.ts';
import { REFERENCE_PERCENT, THREADS, TARGETS, comboEvs, evError, evsOf, fmt, forget, relabel, swapCards, trace } from './measure.ts';
import { SPOTS } from './spots.ts';

const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });

for (const [name, entry] of Object.entries(SPOTS)) {
	if (wanted.length > 0 && !wanted.includes(name)) continue;
	const { config } = entry;
	const pot = config.pot;
	const spot = defineSpot(config);
	console.log(`\n== ${name}: ${config.board} (${spot.players[0].count} vs ${spot.players[1].count} combos)`);

	let started = performance.now();
	const reference = solve(spot, { targetPercent: REFERENCE_PERCENT, iterations: 3000, workers: THREADS });
	const referenceMs = performance.now() - started;
	const referenceEvs = evsOf(spot, reference);
	console.log(
		`reference: ${reference.iterations} iterations, ${(referenceMs / 1000).toFixed(1)} s on ${THREADS} threads, ` +
			`${reference.exploitabilityPercent().toFixed(3)}%; range EV ${referenceEvs[0].rangeEv.toFixed(3)} / ${referenceEvs[1].rangeEv.toFixed(3)}`,
	);
	// Its per-combination EVs, saved for anyone measuring another method.
	const saved = (evs: ComboEv): Record<string, number> => {
		const out: Record<string, number> = {};
		for (let combo = 0; combo < COMBOS; combo++) if (evs.mass[combo] > 0) out[String(combo)] = evs.ev[combo];
		return out;
	};

	const traces: Trace[] = [];
	traces.push(trace('cold', spot, () => createRun(spot, { workers: 1 }), referenceEvs, pot));

	const neighbours: unknown[] = [];
	for (const neighbour of entry.neighbours) {
		const cards = swapCards(neighbour.swap);
		const sourceSpot = defineSpot({ ...config, board: neighbour.board });
		// A sanity check on the relabelling: it must take one board onto the other.
		const mapped = parseCards(config.board).map((card) => cards[card]).sort();
		const sourceBoard = parseCards(neighbour.board).sort();
		if (mapped.some((card, i) => card !== sourceBoard[i])) throw new Error(`${neighbour.board} does not map onto ${config.board}`);

		started = performance.now();
		const source = solve(sourceSpot, { targetPercent: REFERENCE_PERCENT, iterations: 3000, workers: THREADS });
		const sourceMs = performance.now() - started;
		const sourceEvs = evsOf(sourceSpot, source);
		console.log(
			`\n-- from ${neighbour.board} (swap ${neighbour.swap.join('<->')}): ${source.iterations} iterations, ` +
				`${(sourceMs / 1000).toFixed(1)} s, ${source.exploitabilityPercent().toFixed(3)}%`,
		);

		// t = 0, a pure lookup: the neighbour's EVs, relabelled.
		const lookup = [0, 1].map((player) => relabel(sourceEvs[player], referenceEvs[player], cards));
		const lookupError = [0, 1].map((p) => evError(lookup[p].evs, referenceEvs[p], pot));

		// t = 0, the neighbour's average strategy relabelled and played in the target game.
		const analysed = createRun(spot, { analysisOnly: true });
		started = performance.now();
		warmStart(analysed.solver.ctx, source.solver.ctx, true, cards);
		const transferMs = performance.now() - started;
		const averageError = [0, 1].map((p) => evError(comboEvs(spot, analysed.solver, p as 0 | 1), referenceEvs[p], pot));
		const averageExploit = analysed.exploitabilityPercent();
		analysed.close();

		console.log(`  coverage of the target ranges: ${(lookup[0].coverage * 100).toFixed(1)}% / ${(lookup[1].coverage * 100).toFixed(1)}%`);
		console.log(`  t=0 lookup         OOP ${fmt(lookupError[0])}   IP ${fmt(lookupError[1])}   (MAE / max / range, % pot)`);
		console.log(
			`  t=0 avg strategy   OOP ${fmt(averageError[0])}   IP ${fmt(averageError[1])}   exploitability ${averageExploit.toFixed(3)}%, relabel ${transferMs.toFixed(0)} ms`,
		);

		// What a library could actually ship: the whole tree is far too big
		// (the bench flop's regrets are ~250 MB), so also seed only the flop's
		// decisions, or the flop's and turn's, and leave the rest cold.
		const variants: { label: string; keep: number; warmIteration?: number }[] = [
			{ label: 'all streets', keep: 3 },
			{ label: 'flop+turn', keep: 2 },
			{ label: 'flop only', keep: 1 },
			{ label: 'flop only t=10', keep: 1, warmIteration: 10 },
		];
		for (const variant of variants) {
			traces.push(
				trace(
					`${neighbour.board} ${variant.label}`,
					spot,
					() => {
						const run = createRun(spot, { workers: 1, warmStart: source, warmCards: cards, warmIteration: variant.warmIteration });
						forget(run.solver.ctx, variant.keep);
						return run;
					},
					referenceEvs,
					pot,
				),
			);
		}
		neighbours.push({
			board: neighbour.board,
			swap: neighbour.swap,
			sourceIterations: source.iterations,
			sourceExploitability: source.exploitabilityPercent(),
			coverage: lookup.map((l) => l.coverage),
			lookupError,
			averageError,
			averageExploitability: averageExploit,
			transferMs,
		});
	}

	console.log(`\n${name}: iterations (single-thread seconds, checks excluded) to each target`);
	console.log(`${'run'.padEnd(26)}${TARGETS.map((t) => `${t}%`.padStart(16)).join('')}`);
	for (const t of traces) {
		const cells = TARGETS.map((target) => {
			const hit = t.reached[String(target)];
			return (hit ? `${hit.iterations} (${(hit.ms / 1000).toFixed(1)} s)` : '-').padStart(16);
		});
		console.log(`${t.label.padEnd(26)}${cells.join('')}`);
	}

	writeFileSync(
		new URL(`./results/${name}.json`, import.meta.url),
		JSON.stringify(
			{
				config,
				reference: {
					iterations: reference.iterations,
					exploitability: reference.exploitabilityPercent(),
					ms: referenceMs,
					rangeEv: referenceEvs.map((e) => e.rangeEv),
					comboEv: referenceEvs.map(saved),
				},
				neighbours,
				traces,
			},
			null,
			1,
		),
	);
}
