/**
 * Issue #103, part 4: each opt-in, and each pair the documented recipes use,
 * scored on napkinpoker spots against the stored per-action EVs.
 *
 *   node --import tsx bench/reference/options.ts <spot id> <variant...>
 *
 * Every variant runs as many iterations as the exact solve took to 0.3% of
 * pot in `cross-check.ts` (`results/cross-check-<id>.json`; 200 without
 * one), on 4 threads (chance sampling: 1, which is all it runs on). So each
 * number is the cost of the option at equal iterations, not equal time; the
 * seconds are there to show what it buys. Writes `results/options-<id>.json`.
 *
 * Read the losses as: % of the node's pot our play gives up, per hand, at the
 * stored EVs, reach-weighted (see `score.ts`). The stored strategy's own loss
 * (`ref`) is the reference's noise floor at the same node.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRun, defineSpot, resolveSubgame } from '../../src/index.ts';
import type { Solution, SolveOptions, SpotConfig } from '../../src/index.ts';
import { wasmStorage } from '../../src/wasm-storage.ts';
import { napkinSpots } from './napkinpoker.ts';
import { locate, scoreSolution, scoreSubgame, storedNodes, summarise } from './score.ts';
import type { NodeScore } from './score.ts';

interface Variant {
	readonly config?: Partial<SpotConfig>;
	readonly solve?: SolveOptions;
	/** Solve a blueprint with one turn/river bet, no raise or shove there, and re-solve each stored turn. */
	readonly resolve?: boolean;
	/** Iterations as a multiple of the exact solve's, for an option whose iterations are cheaper. */
	readonly scale?: number;
}

const sampling: SolveOptions = { approximations: { chanceSampling: {} } };

export const VARIANTS: Record<string, Variant> = {
	exact: {},
	shareHistories: { config: { shareHistories: true } },
	compactStorage: { config: { compactStorage: {} }, solve: { wasmStorage } },
	thinSizes: { config: { thinSizes: true } },
	runoutBuckets: { config: { runoutBuckets: 3 } },
	chanceSampling: { solve: sampling },
	// Its iterations take about half the time of 4 exact threads: twice as many is about equal time.
	'chanceSampling, 2× iterations': { solve: sampling, scale: 2 },
	coarseStart: { solve: { approximations: { coarseStart: { iterations: 40 } } } },
	lineRunouts: { config: { lineRunouts: { aggressions: 2 } } },
	i16: { solve: { precision: 'i16', wasmStorage } },
	resolveSubgame: { resolve: true },
	// Pairs the README's recipes use.
	'runoutBuckets+i16': { config: { runoutBuckets: 3 }, solve: { precision: 'i16', wasmStorage } },
	'runoutBuckets+resolveSubgame': { config: { runoutBuckets: 3 }, resolve: true },
	'shareHistories+runoutBuckets': { config: { shareHistories: true, runoutBuckets: 3 } },
	'shareHistories+chanceSampling': { config: { shareHistories: true }, solve: sampling },
	'shareHistories+compactStorage': { config: { shareHistories: true, compactStorage: {} }, solve: { wasmStorage } },
	'thinSizes+shareHistories': { config: { thinSizes: true, shareHistories: true } },
	'lineRunouts+runoutBuckets': { config: { lineRunouts: { aggressions: 2 }, runoutBuckets: 3 } },
};

/** The blueprint `resolveSubgame` refines: the flop as it is, one 75% bet on the turn and river. */
function blueprintOf(config: SpotConfig): SpotConfig {
	const rows = config.betSizes as number[][];
	const raises = config.raiseSizes as { times: number }[][];
	return {
		...config,
		betSizes: [rows[0], [0.75], [0.75]],
		raiseSizes: [raises[0], [], []],
		maxRaises: [(config.maxRaises as number[])[0], 1, 1],
		allowAllIn: [(config.allowAllIn as boolean[])[0], false, false],
	};
}

const brief = (n: NodeScore | null): { loss: number; ref: number } | null => n && { loss: n.loss, ref: n.refLoss };

function main(): void {
	const [id, ...names] = process.argv.slice(2);
	const napkin = napkinSpots().find((s) => s.id === id);
	if (!napkin) throw new Error(`no spot ${id}`);
	const cross = new URL(`results/cross-check-${id}.json`, import.meta.url);
	const iterations = existsSync(cross) ? (JSON.parse(readFileSync(cross, 'utf8')) as { iterations: number }).iterations : 200;
	const file = new URL(`results/options-${id}.json`, import.meta.url);
	const results: Record<string, unknown> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
	for (const name of names.length ? names : Object.keys(VARIANTS)) {
		const variant = VARIANTS[name];
		if (!variant) throw new Error(`no variant ${name}`);
		const base = { ...napkin.config, maxBytes: 1e13 };
		const config: SpotConfig = { ...(variant.resolve ? blueprintOf(base) : base), ...variant.config };
		const start = performance.now();
		const spot = defineSpot(config);
		const run = createRun(spot, { workers: 4, ...variant.solve });
		run.step(Math.round(iterations * (variant.scale ?? 1)));
		const solveSeconds = (performance.now() - start) / 1000;
		const exploitability = run.exploitabilityPercent();
		const trueExploitability = variant.resolve ? Number.NaN : run.trueExploitabilityPercent();
		const sol = run.snapshot();
		run.close();
		const score = scoreSolution(sol, id);
		const result: Record<string, unknown> = {
			iterations: run.completed,
			workers: run.workers,
			engine: run.engine,
			bytes: spot.estimate.compactBytes ?? (variant.solve?.precision === 'i16' ? spot.estimate.compressedBytes : spot.estimate.bytes),
			solveSeconds,
			exploitability,
			trueExploitability,
			rootOop: brief(score.root.oop),
			rootIp: brief(score.root.ip),
			flop: score.flop,
			turn: score.turn,
			missing: score.missing.length,
		};
		if (variant.resolve) result.resolved = resolveTurns(sol, id, napkin.config);
		results[name] = result;
		console.log(name, JSON.stringify({ ...result, resolved: undefined }));
		if (variant.resolve) console.log('  re-solved turns', JSON.stringify((result.resolved as { summary: unknown }).summary));
		mkdirSync(new URL('results/', import.meta.url), { recursive: true });
		writeFileSync(file, JSON.stringify(results, null, '\t'));
	}
}

/** Re-solve every scored stored turn node from the blueprint with the spot's full betting, and score it. */
function resolveTurns(blueprint: Solution, id: string, full: SpotConfig): { summary: unknown; nodes: NodeScore[] } {
	const nodes: NodeScore[] = [];
	const start = performance.now();
	const betting = {
		betSizes: (full.betSizes as number[][]).slice(1),
		raiseSizes: (full.raiseSizes as { times: number }[][]).slice(1),
		maxRaises: (full.maxRaises as number[]).slice(1),
		allowAllIn: (full.allowAllIn as boolean[]).slice(1),
	};
	let skipped = 0;
	for (const stored of storedNodes(id, 'turn')) {
		const at = locate(blueprint, stored);
		if (!at) {
			skipped++;
			continue;
		}
		const sub = resolveSubgame(blueprint, at.node, at.board, {
			player: stored.actor,
			betting,
			iterations: 200,
			solve: { workers: 4 },
		});
		const scored = scoreSubgame(sub.solution, stored, at.relabel);
		if (scored) nodes.push(scored);
		else skipped++;
	}
	return {
		summary: { ...summarise(nodes), skipped, seconds: (performance.now() - start) / 1000 },
		nodes,
	};
}

main();
