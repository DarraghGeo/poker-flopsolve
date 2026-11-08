/**
 * Grow a budgeted tree and measure it (issue #51).
 *
 *   node --import tsx bench/adaptive/run.ts <board> <full> <budgetGiB> [rounds] [workers]
 *
 * Starts from `full` (a tree in `TREES`, `T` or `T0`) cut to one size per node,
 * then each round probes every cut line, ranks them by best-response gain per
 * byte and adds the best until the budget (32-bit storage, as
 * `Estimate.bytes` counts it) is used: half of what is left on each round but
 * the last, all of it on the last. The final tree is solved to 0.3% of pot and
 * compared with the reference in `results/<board>-<full>.json` when there is
 * one. Writes `results/<board>-<full>-adaptive-<budget>.json`.
 *
 *   node --import tsx bench/adaptive/run.ts <board> <full> static <tree>
 *
 * solves a named tree of `TREES` instead, to the same target, and measures it
 * the same way.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { defineSpot } from '../../src/index.ts';
import type { SolveRun, SpotConfig } from '../../src/index.ts';
import { ActionKind } from '../../src/tree.ts';
import type { GrowRound } from './grow.ts';
import { budgetedConfig, cutsFor, indexFull, probeAll, release, solveTo, treeBytes } from './grow.ts';
import type { FullTree, SizedEdge } from './grow.ts';
import type { ComboEvs } from './measure.ts';
import { comboError, rootActionEvs, rootEvs } from './measure.ts';
import type { BoardName } from './spots.ts';
import { spotOn } from './spots.ts';
import { TREES } from './trees.ts';

const GiB = 2 ** 30;

/**
 * Static rules, as the sized edges of the full tree each keeps. Every rule
 * keeps the one-size base (0.75 bets and raises, a shove where 0.75 would be).
 */
const STATIC_RULES: Record<string, (edge: SizedEdge) => boolean> = {
	/** The issue's rule: three sizes on flop and turn opening bets, one facing a bet and on the river. */
	opening: (e) => e.base || (e.kind === ActionKind.Bet && !e.facingBet && e.round < 2),
	/** Three opening sizes on the flop only. */
	flopOpening: (e) => e.base || (e.kind === ActionKind.Bet && !e.facingBet && e.round === 0),
	/** The one-size base itself. */
	base: (e) => e.base,
};
const [board = 'rainbow', fullName = 'T', third = '2', fourth = '4', fifth = '4', seed = 'base'] = process.argv.slice(2);
const isStatic = third === 'static';
const workers = Number(fifth);
const log = (message: string): void => console.log(message);
// First-order gain after 60 probe iterations ranked lines best in calibrate.ts (Spearman 0.81 on the turn).
const options = { workers, probeIterations: 60, probeResume: 10, boardStride: 4, estimator: 'firstOrder' as const, log };

const full = indexFull(spotOn(board as BoardName, TREES[fullName]));
const referenceFile = new URL(`./results/${board}-${fullName}.json`, import.meta.url);
const reference = existsSync(referenceFile) ? (JSON.parse(readFileSync(referenceFile, 'utf8')) as { evs: ComboEvs; actions: Record<string, (number | null)[]> }) : null;

const started = performance.now();
let config: SpotConfig;
const rounds: GrowRound[] = [];
let kept: Set<string> | null = null;

if (isStatic && fourth in STATIC_RULES) {
	kept = new Set([...full.sized.values()].filter(STATIC_RULES[fourth]).map((info) => info.path));
	config = budgetedConfig(full, kept);
} else if (isStatic) {
	config = spotOn(board as BoardName, TREES[fourth]);
} else {
	const budget = Number(third) * GiB;
	const maxRounds = Number(fourth);
	// Growth starts from a static rule: the one-size base unless another is named.
	kept = new Set([...full.sized.values()].filter(STATIC_RULES[seed]).map((info) => info.path));
	let current = solveTo(budgetedConfig(full, kept), 1, 400, options);
	log(`base: ${(treeBytes(full, kept) / GiB).toFixed(3)} GiB, ${current.exploitability.toFixed(2)}% in ${current.seconds.toFixed(0)} s`);
	for (let round = 0; round < maxRounds; round++) {
		const roundStart = performance.now();
		const bytes = treeBytes(full, kept);
		const left = budget - bytes;
		const allowance = round === maxRounds - 1 ? left : left / 2;
		const probed = await probeAll(full, kept, current.run, { ...options, probeBytes: process.env.PROBE_GIB ? Number(process.env.PROBE_GIB) * GiB : Math.max(budget, bytes * 1.5) });
		probed.sort((a, b) => b.gain / b.bytes - a.gain / a.bytes);
		const added: GrowRound['added'] = [];
		let spent = 0;
		for (const entry of probed) {
			if (!(entry.gain > 0) || spent + entry.bytes > allowance) continue;
			added.push(entry);
			spent += entry.bytes;
		}
		rounds.push({
			bytes, exploitability: current.exploitability, candidates: probed.length, added,
			seconds: (performance.now() - roundStart) / 1000,
		});
		log(`round ${round + 1}: ${probed.length} candidates, added ${added.length} for ${(spent / GiB).toFixed(3)} GiB`);
		for (const entry of added.slice(0, 12)) log(`  + ${entry.line}: ${entry.gain.toFixed(4)}% for ${(entry.bytes / 2 ** 20).toFixed(1)} MiB`);
		if (added.length === 0) break;
		for (const entry of added) kept.add(entry.line);
		const previous = current.run;
		current = solveTo(budgetedConfig(full, kept), 1, 400, options, previous, 10);
		previous.close();
		await release();
	}
	current.run.close();
	await release();
	config = budgetedConfig(full, kept);
}

// The final tree, solved cold to the target as a user would.
const growSeconds = (performance.now() - started) / 1000;
const final = solveTo(config, 0.3, 2000, options);
final.run.close();
const measured = measure(final.run, final.seconds, final.exploitability);
const name = isStatic ? `static-${fourth}` : `adaptive-${third}${seed === 'base' ? '' : `-${seed}`}${process.env.PROBE_GIB ? `-probe${process.env.PROBE_GIB}` : ''}`;
const out = {
	board, full: fullName, name, config, growSeconds: isStatic ? 0 : growSeconds, rounds, ...measured,
	sizes: kept ? sizesSummary(full, kept) : null,
	// Peak resident memory of the whole process, growth included.
	peakRssGiB: process.resourceUsage().maxRSS / 2 ** 20,
};
writeFileSync(new URL(`./results/${board}-${fullName}-${name}.json`, import.meta.url), JSON.stringify(out, null, 1));
log(JSON.stringify({ ...out, config: undefined, rounds: rounds.map((r) => ({ ...r, added: r.added.length })), evs: undefined, actions: undefined }, null, 1));

function measure(run: SolveRun, seconds: number, exploitability: number) {
	const spot = run.spot;
	const evs = rootEvs(run);
	const actions = rootActionEvs(run);
	const result: Record<string, unknown> = {
		bytes: spot.estimate.bytes, compressedBytes: spot.estimate.compressedBytes, iterations: run.completed,
		seconds, exploitability, evs, actions,
	};
	if (reference) {
		result.error = comboError(evs, reference.evs, run);
		result.rootSizes = rootSizeAgreement(run, actions, reference.actions);
	}
	return result;
}

/**
 * For the root actor's combinations: the EV error at each root action both
 * trees offer, and how often the best root bet size agrees with the reference.
 */
function rootSizeAgreement(run: SolveRun, actions: Record<string, number[]>, ref: Record<string, (number | null)[]>) {
	const w = run.spot.players[0].weights;
	const shared = Object.keys(actions).filter((label) => label in ref);
	const bets = shared.filter((label) => label.startsWith('bet'));
	const errors: Record<string, number> = {};
	for (const label of shared) {
		let sum = 0;
		let mass = 0;
		for (let h = 0; h < w.length; h++) {
			const a = actions[label][h];
			const b = ref[label][h];
			if (!(w[h] > 0) || a === null || b === null || Number.isNaN(a)) continue;
			sum += w[h] * Math.abs(a - (b as number));
			mass += w[h];
		}
		errors[label] = sum / mass;
	}
	let agree = 0;
	let total = 0;
	for (let h = 0; h < w.length; h++) {
		if (!(w[h] > 0) || bets.length < 2) continue;
		const best = (source: Record<string, (number | null)[]>): string =>
			bets.reduce((x, y) => ((source[y][h] as number) > (source[x][h] as number) ? y : x));
		total += w[h];
		if (best(actions) === best(ref)) agree += w[h];
	}
	return { errors, bets, agreement: total > 0 ? agree / total : null };
}

/**
 * Which nodes keep how many opening sizes: per round and facing a bet or not,
 * the count of nodes of the budgeted tree by the number of bets (or raises)
 * they offer, shoves aside.
 */
function sizesSummary(fullTree: FullTree, keep: Set<string>) {
	const cuts = new Set(cutsFor(fullTree, keep));
	const counts: Record<string, Record<number, number>> = {};
	const { tree } = fullTree;
	const walk = (node: number): void => {
		if (tree.kind[node] === 0) {
			let sizes = 0;
			let facing = false;
			for (let e = 0; e < tree.numEdges[node]; e++) {
				const edge = tree.firstEdge[node] + e;
				const info = fullTree.sized.get(edge);
				if (tree.edgeAction[edge] === ActionKind.Call) facing = true;
				if (info && info.kind !== ActionKind.AllIn && !cuts.has(info.path)) sizes++;
			}
			const key = `round ${tree.round[node]} ${facing ? 'facing a bet' : 'opening'}`;
			counts[key] ??= {};
			counts[key][sizes] = (counts[key][sizes] ?? 0) + 1;
		}
		for (let e = 0; e < tree.numEdges[node]; e++) {
			const edge = tree.firstEdge[node] + e;
			const info = fullTree.sized.get(edge);
			if (info && cuts.has(info.path)) continue;
			walk(tree.edgeChild[edge]);
		}
	};
	walk(0);
	return counts;
}
