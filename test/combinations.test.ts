/**
 * The opt-in options in pairs (issue #103). Three of the bugs before this
 * (#86, #88, #94) appeared only when two options met, so every pair of
 *
 *   shareHistories, compactStorage, thinSizes, runoutBuckets, chanceSampling,
 *   coarseStart, lineRunouts, wasmStorage at 16 bits, resolveSubgame
 *
 * is solved here on one small turn spot, and either runs or is refused:
 *
 * - refused: exactly the pairs `REFUSED` lists, each with an error naming
 *   both sides;
 * - repeatable: two solves on two threads leave every stored value equal,
 *   and one thread agrees with two to float rounding;
 * - off is identical: each option set to its off value beside another
 *   leaves that other's solve bit for bit as it was alone;
 * - JS and WASM agree where both engines run the pair: the WebAssembly
 *   engine follows JavaScript's update step for step;
 * - sane: no pair is much further from equilibrium than its worse half.
 */

import { describe, expect, it } from 'vitest';
import { parseCards } from '../src/cards.ts';
import { engineAvailable } from '../src/engine.ts';
import { createRun, defineSpot, NodeKind, resolveSubgame } from '../src/index.ts';
import type { Solution, SolveOptions, SolveRun, SpotConfig } from '../src/index.ts';
import { wasmStorage } from '../src/wasm-storage.ts';
import { compareStorage, copyStorage, storageArrays } from './wasm-storage-helpers.ts';

/** Small enough to solve in milliseconds, rich enough for every option to act. */
const turn: SpotConfig = {
	board: 'Ah Kd Qc 8s', pot: 60, stack: 90,
	oop: 'AA,KK,55,44,AKs,KQs', ip: 'QQ,JJ,33,22,AQs,QJs',
	betSizes: [[0.5, 1]], raiseSizes: [[1]], maxRaises: 2,
};

/** One option: what it sets on the spot and the solve, and what "off" looks like. */
interface Option {
	readonly name: string;
	readonly config?: Partial<SpotConfig>;
	readonly solve?: SolveOptions;
	/** Re-solve the river below the turn's check-check after solving. */
	readonly resolve?: boolean;
	/** The option given its off value, which must change nothing. */
	readonly off?: { readonly config?: Partial<SpotConfig>; readonly solve?: SolveOptions };
}

const OPTIONS: readonly Option[] = [
	{ name: 'shareHistories', config: { shareHistories: true }, off: { config: { shareHistories: false } } },
	{ name: 'compactStorage', config: { compactStorage: {} } },
	{ name: 'thinSizes', config: { thinSizes: true }, off: { config: { thinSizes: false } } },
	{ name: 'runoutBuckets', config: { runoutBuckets: 3 }, off: { config: { runoutBuckets: false } } },
	{
		name: 'chanceSampling',
		solve: { approximations: { chanceSampling: { p: 0.5 } } },
		off: { solve: { approximations: { chanceSampling: { p: 1 } } } },
	},
	{
		name: 'coarseStart',
		// Wider than runoutBuckets' 3, so it still coarsens beside it.
		solve: { approximations: { coarseStart: { iterations: 6, runoutBuckets: 6 } } },
		off: { solve: { approximations: { coarseStart: { iterations: 0 } } } },
	},
	{ name: 'lineRunouts', config: { lineRunouts: { aggressions: 1 } } },
	// At 32 bits the engine runs as it always has, wasmStorage or not.
	{ name: 'wasmStorage i16', solve: { precision: 'i16', wasmStorage }, off: { solve: { wasmStorage } } },
	{ name: 'resolveSubgame', resolve: true },
];

/** Pairs refused, with a pattern each refusal's message matches. */
const REFUSED: Record<string, RegExp> = {
	'shareHistories + lineRunouts': /lineRunouts does not combine with shareHistories or compactStorage/,
	'compactStorage + lineRunouts': /lineRunouts does not combine with shareHistories or compactStorage/,
	'chanceSampling + lineRunouts': /lineRunouts does not combine with chanceSampling, coarseStart/,
	'coarseStart + lineRunouts': /lineRunouts does not combine with chanceSampling, coarseStart/,
	'chanceSampling + wasmStorage i16': /chanceSampling needs 32- or 64-bit storage/,
};

const ITERATIONS = 12;

/** Options merged, approximations included. */
function merge(parts: readonly { config?: Partial<SpotConfig>; solve?: SolveOptions }[]): { config: SpotConfig; solve: SolveOptions } {
	let config: SpotConfig = turn;
	let solve: SolveOptions = {};
	for (const part of parts) {
		config = { ...config, ...part.config };
		solve = { ...solve, ...part.solve, approximations: { ...solve.approximations, ...part.solve?.approximations } };
	}
	return { config, solve };
}

/** The river opened by the turn's check-check, where `resolveSubgame` re-solves. */
function riverNode(sol: Solution): number {
	const { tree } = sol.spot;
	const check = tree.edgeChild[tree.firstEdge[0]];
	const chance = tree.edgeChild[tree.firstEdge[check]];
	if (tree.kind[chance] !== NodeKind.Chance) throw new Error('check-check does not deal the river');
	return tree.edgeChild[tree.firstEdge[chance]];
}

/** What a solve leaves, for comparing two. */
interface Outcome {
	/** Every stored array, by name. */
	readonly storage: [string, ArrayLike<number>][];
	/** The root's strategy; with `resolveSubgame`, the re-solved river root's after it. */
	readonly probs: Float64Array;
	/** True exploitability of the blueprint, % of pot. */
	readonly exploitability: number;
}

/** Solve a set of options on `workers` threads; a re-solve runs on the same. */
function solveWith(parts: readonly Option[], workers: number, override: SolveOptions = {}): Outcome {
	const { config, solve } = merge(parts);
	const resolve = parts.some((p) => p.resolve);
	const run = createRun(defineSpot(config), { workers, ...solve, ...override });
	try {
		run.step(ITERATIONS);
		const storage = storageArrays(run).map(([name, array]) => [name, Array.from(array as ArrayLike<number>)] as [string, number[]]);
		const exploitability = run.trueExploitabilityPercent();
		const sol = run.snapshot();
		let probs = Float64Array.from(sol.strategyAt(0, 0).probs);
		if (resolve) {
			run.close();
			const node = riverNode(sol);
			const board = sol.spot.resolveBoard([...sol.spot.board, ...parseCards('2h')], node).board;
			const sub = resolveSubgame(sol, node, board, {
				player: 0,
				iterations: ITERATIONS,
				solve: { workers, ...(solve.precision ? { precision: solve.precision } : {}), ...(solve.wasmStorage ? { wasmStorage } : {}) },
			});
			const root = sub.solution.strategyAt(0, 0).probs;
			probs = Float64Array.from([...probs, ...root]);
		}
		return { storage, probs, exploitability };
	} finally {
		run.close();
	}
}

const pairs: [Option, Option][] = [];
OPTIONS.forEach((a, i) => OPTIONS.slice(i + 1).forEach((b) => pairs.push([a, b])));
const key = (a: Option, b: Option): string => `${a.name} + ${b.name}`;

const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
	expect(a.length).toBe(b.length);
	let worst = 0;
	for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
	return worst;
};

describe.runIf(engineAvailable())('opt-in options in pairs', () => {
	it('lists every pair once: 36 of them, 5 refused', () => {
		expect(pairs).toHaveLength(36);
		for (const name of Object.keys(REFUSED)) expect(pairs.map(([a, b]) => key(a, b))).toContain(name);
	});

	const alone = new Map<string, Outcome>();
	const aloneOf = (option: Option): Outcome => {
		let outcome = alone.get(option.name);
		if (!outcome) alone.set(option.name, (outcome = solveWith([option], 2)));
		return outcome;
	};

	for (const [a, b] of pairs) {
		const name = key(a, b);
		const refusal = REFUSED[name];
		if (refusal) {
			it(`${name}: refused`, () => {
				expect(() => solveWith([a, b], 2)).toThrow(refusal);
			});
			continue;
		}
		it(`${name}: runs, repeats on 2 threads, matches 1 thread, and is no worse than its halves`, () => {
			const first = solveWith([a, b], 2);
			const again = solveWith([a, b], 2);
			expect(again.storage.map(([n]) => n)).toEqual(first.storage.map(([n]) => n));
			first.storage.forEach(([n, values], i) => expect(maxDiff(values, again.storage[i][1]), `${n} repeats`).toBe(0));
			expect(maxDiff(first.probs, again.probs)).toBe(0);

			const one = solveWith([a, b], 1);
			expect(maxDiff(first.probs, one.probs), '1 thread against 2').toBeLessThan(2e-3);

			const worse = Math.max(aloneOf(a).exploitability, aloneOf(b).exploitability);
			expect(first.exploitability, `exploitability against ${worse.toFixed(2)}% alone`).toBeLessThan(1.5 * worse + 1);
		});
	}

	for (const option of OPTIONS) {
		for (const other of OPTIONS) {
			if (other === option || !other.off || REFUSED[key(option, other)] || REFUSED[key(other, option)]) continue;
			// wasmStorage is what moves compact storage onto the engine: no off value there.
			if (other.name === 'wasmStorage i16' && option.name === 'compactStorage') continue;
			it(`${option.name} beside ${other.name} off: identical to ${option.name} alone`, () => {
				// Sampling always runs on one thread, and keeps its baselines even at p = 1.
				const workers = other.name === 'chanceSampling' ? 1 : 2;
				const by = solveWith([option], workers);
				const off = solveWith([option, { name: `${other.name} off`, ...other.off }], workers);
				const names = off.storage.map(([n]) => n);
				for (const [n, values] of by.storage) {
					expect(names, n).toContain(n);
					expect(maxDiff(values, off.storage[names.indexOf(n)][1]), n).toBe(0);
				}
				expect(maxDiff(by.probs, off.probs)).toBe(0);
			});
		}
	}

	for (const [a, b] of pairs) {
		const name = key(a, b);
		if (REFUSED[name]) continue;
		const { config, solve } = merge([a, b]);
		it(`${name}: the WebAssembly engine follows JavaScript step for step where it runs the pair`, () => {
			// Compact storage reaches the engine through wasmStorage.
			const engine = createRun(defineSpot(config), { workers: 2, ...solve, ...(config.compactStorage ? { wasmStorage } : {}) });
			const js = createRun(defineSpot(config), { workers: 1, ...solve, engine: 'js' });
			try {
				if (engine.engine !== 'wasm') {
					// Only line runouts keep a pair on JavaScript.
					expect([a.name, b.name]).toContain('lineRunouts');
					return;
				}
				expect(js.engine).toBe('js');
				for (let t = 1; t <= 4; t++) {
					copyStorage(engine, js);
					js.step(1);
					engine.step(1);
					for (const [array, share] of compareStorage(js, engine)) {
						const exact = array === 'lastWalk' || array === 'lastUpdate' || array === 'discounted';
						expect(share, `${array} after iteration ${t}`).toBeLessThanOrEqual(exact ? 0 : 0.03);
					}
				}
			} finally {
				engine.close();
				js.close();
			}
		});
	}
});
