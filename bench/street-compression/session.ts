/**
 * A Lite session under `streetCompression`: what a range move and a betting
 * edit cost when the blueprint is kept live (`openLite`), with and without
 * kept sets.
 *
 *   node --import tsx bench/street-compression/session.ts [board] [workers]
 *
 * On issue #47's betting with the wide ranges of `wide-ranges.txt`
 * (`RANGES=<file>` for others), for each variant in `VARIANTS` (as
 * `measure.ts` reads it; `flop` is left out here, since `compressRanges`
 * compresses again at every move and gets a new run) it opens a session and
 * prints seconds and iterations to settle for: the opening solve; in
 * position's range reweighed (a fifth of its hand classes to half weight);
 * the same for another fifth; a flop bet size moved (0.33 to 0.5); and a
 * hand class added from the session's reserve. Under each is what a new
 * `solveLite` of the same spot took, as a caller without the session would
 * pay, so the line shows what starting warm saves with and without kept
 * sets. Then the exploitability of where the session ended, in the same
 * tree with every hand on every runout.
 */

import { readFileSync } from 'node:fs';
import { createRun, defineSpot, openLite, parseRange, releaseSetupCache, solveLite } from '../../src/index.ts';
import type { SolveLiteOptions, SpotConfig } from '../../src/index.ts';
import { COMBO_CARDS } from '../../src/cards.ts';
import { warmStart } from '../../src/warm.ts';
import { BOARDS, full, type Board } from '../blueprint-share/spots.ts';

const [boardArg, workerArg] = process.argv.slice(2);
const board = (boardArg ?? 'two-tone') as Board;
const WORKERS = Number(workerArg ?? 4);
const variants = (process.env.VARIANTS ?? 'lite;river=0.01;river=0.02;turn=0.01,river=0.02').split(';');
const [oop, ip] = readFileSync(process.env.RANGES ?? new URL('./wide-ranges.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);
if (!(board in BOARDS)) throw new Error(`board must be one of ${Object.keys(BOARDS)}`);

function options(variant: string): SolveLiteOptions {
	if (variant === 'lite') return {};
	const streets: Record<string, number> = {};
	for (const part of variant.split(',')) {
		const [street, value] = part.split('=');
		streets[street] = Number(value);
	}
	return { streetCompression: { ...(streets.turn ? { turn: streets.turn } : {}), ...(streets.river ? { river: streets.river } : {}) } };
}

/** A range with every fifth hand class (by rank pair and suitedness) at `factor` times its weight. */
function reweighed(range: string, factor: number, offset: number): Float64Array {
	const weights = parseRange(range);
	const classes = new Map<string, number>();
	return weights.map((weight, combo) => {
		const a = COMBO_CARDS[combo * 2];
		const b = COMBO_CARDS[combo * 2 + 1];
		const key = `${Math.max(a >> 2, b >> 2)}-${Math.min(a >> 2, b >> 2)}-${(a & 3) === (b & 3)}`;
		if (!classes.has(key)) classes.set(key, classes.size);
		return (classes.get(key)! + offset) % 5 === 0 ? weight * factor : weight;
	});
}

const ADDED = '72o';
const config: SpotConfig = { ...full(board), oop, ip, ipReserve: `${ip},${ADDED}` };
const moved = (config.betSizes as number[][]).map((row, r) => (r === 0 ? row.map((size) => (size === 0.33 ? 0.5 : size)) : row)) as SpotConfig['betSizes'];
const first = reweighed(ip, 0.5, 0);
const second = reweighed(ip, 0.5, 2);
/** Each move: its name, what it does to the session, and the spot it leaves. */
const moves: { name: string; apply: (session: ReturnType<typeof openLite>) => unknown; spot: SpotConfig }[] = [
	{ name: 'reweigh', apply: (session) => session.setRange(1, first), spot: { ...config, ip: first } },
	{ name: 'reweigh again', apply: (session) => session.setRange(1, second), spot: { ...config, ip: second } },
	{ name: 'bet size moved', apply: (session) => session.edit({ betSizes: moved }), spot: { ...config, ip: second, betSizes: moved } },
	{ name: 'hand added', apply: (session) => session.setRange(1, `${ip},${ADDED}`), spot: { ...config, ip: `${ip},${ADDED}`, betSizes: moved } },
];
console.log(`\n${board} (${config.board}), ${WORKERS} threads; seconds (iterations) to settle: the session, then a new solveLite of the same spot`);
console.log(`variant                  | open            | ${moves.map((move) => move.name.padEnd(33)).join(' | ')} | exploitable %`);
for (const variant of variants) {
	releaseSetupCache();
	const settings = { workers: WORKERS, ...options(variant) };
	const cells: string[] = [];
	const cell = (seconds: number, iterations: number): string => `${seconds.toFixed(1).padStart(6)} s (${String(iterations).padStart(4)})`;
	let started = performance.now();
	const session = openLite(config, settings);
	let before = session.iterations;
	cells.push(cell((performance.now() - started) / 1000, before));
	for (const move of moves) {
		started = performance.now();
		move.apply(session);
		const warm = cell((performance.now() - started) / 1000, session.iterations - before);
		before = session.iterations;
		started = performance.now();
		const cold = solveLite(move.spot, settings);
		cells.push(`${warm} ${cell((performance.now() - started) / 1000, cold.solution.totalIterations)}`);
	}
	// As `trueExploitabilityPercent` reads a run: the strategy in the same tree with every hand on every runout.
	const exact = createRun(defineSpot({ ...session.current.solution.spot.source, runoutBuckets: false, streetCompression: undefined }), { workers: WORKERS });
	warmStart(exact.solver.ctx, session.current.solution.solver.ctx, true);
	const exploitable = exact.exploitabilityPercent();
	exact.close();
	console.log(`${variant.padEnd(24)} | ${cells.join(' | ')} | ${exploitable.toFixed(2).padStart(8)}`);
	session.close();
}
