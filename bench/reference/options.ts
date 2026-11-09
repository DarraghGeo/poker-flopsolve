/**
 * Issue #103, part 4: each opt-in, and each pair the documented recipes use,
 * scored on napkinpoker spots against the stored per-action EVs.
 *
 *   node --import tsx bench/reference/options.ts <spot id> <variant...>
 *
 * Every variant runs as many iterations as the exact solve took to 0.3% of
 * pot in `cross-check.ts` (`results/cross-check-<id>.json`; 200 without
 * one), on 4 threads. So each
 * number is the cost of the option at equal iterations, not equal time; the
 * seconds are there to show what it buys. Writes `results/options-<id>.json`.
 *
 * Read the losses as: % of the node's pot our play gives up, per hand, at the
 * stored EVs, reach-weighted (see `score.ts`). The stored strategy's own loss
 * (`ref`) is the reference's noise floor at the same node.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRun, defineSpot, litePreset, resolveSubgame, trackSettle } from '../../src/index.ts';
import type { Solution, SolveOptions, SpotConfig } from '../../src/index.ts';
import { largeTree, wasmStorage } from '../../src/wasm-storage.ts';
import { settlePlan } from '../../src/settle.ts';
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
	/**
	 * A preset (issue #115): the spot and solve settings it makes of the
	 * spot's own. `settle` from it stops the run (checked every 20
	 * iterations, capped at `scale` times the exact solve's iterations).
	 */
	readonly preset?: (config: SpotConfig) => { config: SpotConfig; solve: SolveOptions };
}

const sampling: SolveOptions = { approximations: { chanceSampling: {} } };

export const VARIANTS: Record<string, Variant> = {
	exact: {},
	shareHistories: { config: { shareHistories: true } },
	compactStorage: { config: { compactStorage: {} }, solve: { wasmStorage } },
	thinSizes: { config: { thinSizes: true } },
	runoutBuckets: { config: { runoutBuckets: 3 } },
	chanceSampling: { solve: sampling },
	// Its iterations take about a fifth of the time of exact ones on 4 threads (#99).
	'chanceSampling, 2× iterations': { solve: sampling, scale: 2 },
	'chanceSampling, 4× iterations': { solve: sampling, scale: 4 },
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
	// The presets (issue #115), as a caller gets them. Lite stops on its own
	// rule; the large-tree preset samples, so it gets sampling's 4×.
	litePreset: {
		preset: (config) => {
			const { config: blueprint, options } = litePreset(config);
			return { config: blueprint, solve: options };
		},
		scale: 10,
	},
	largeTree: {
		preset: (config) => {
			const { config: thinned, options } = largeTree(config);
			return { config: thinned, solve: options };
		},
		scale: 4,
	},
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
		const given: SpotConfig = { ...(variant.resolve ? blueprintOf(base) : base), ...variant.config };
		const preset = variant.preset?.(given);
		const config = preset?.config ?? given;
		const { settle, iterations: _cap, ...presetSolve } = preset?.solve ?? {};
		const start = performance.now();
		const spot = defineSpot(config);
		const run = createRun(spot, { workers: 4, ...variant.solve, ...presetSolve });
		const cap = Math.round(iterations * (variant.scale ?? 1));
		if (settle) {
			const tracker = trackSettle(settle);
			const { every } = settlePlan(settle);
			// As solve()'s settle loop: a short last step is not a check.
			while (run.completed < cap) {
				const step = Math.min(every, cap - run.completed);
				run.step(step);
				if (step === every && tracker.check(run.snapshot(), run.completed)) break;
			}
		} else run.step(cap);
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
			bytes: spot.estimate.compactBytes ?? ((presetSolve.precision ?? variant.solve?.precision) === 'i16' ? spot.estimate.compressedBytes : spot.estimate.bytes),
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
