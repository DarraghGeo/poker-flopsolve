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
 * the same again the other way; a flop bet size moved (0.33 to 0.5); and a
 * hand class added, which a session with kept sets takes on a new run.
 * Then the exploitability of where it ended, in the same tree with every
 * hand on every runout.
 */

import { readFileSync } from 'node:fs';
import { createRun, defineSpot, openLite, parseRange, releaseSetupCache } from '../../src/index.ts';
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

const config: SpotConfig = { ...full(board), oop, ip };
console.log(`\n${board} (${config.board}), ${WORKERS} threads; seconds (iterations) to settle`);
console.log('variant                  | open            | reweigh         | reweigh back    | bet size moved  | hand added      | exploitable %');
for (const variant of variants) {
	releaseSetupCache();
	const cells: string[] = [];
	let before = 0;
	const timed = (step: () => unknown): void => {
		const started = performance.now();
		step();
		// The session's own count: a solution's restarts where a move resumes.
		const total = session.iterations;
		cells.push(`${((performance.now() - started) / 1000).toFixed(1).padStart(6)} s (${String(total - before).padStart(4)})`);
		before = total;
	};
	let session!: ReturnType<typeof openLite>;
	timed(() => {
		session = openLite(config, { workers: WORKERS, ...options(variant) });
		return session.current;
	});
	timed(() => session.setRange(1, reweighed(ip, 0.5, 0)));
	timed(() => session.setRange(1, reweighed(ip, 0.5, 2)));
	timed(() => session.edit({ betSizes: (config.betSizes as number[][]).map((row, r) => (r === 0 ? row.map((size) => (size === 0.33 ? 0.5 : size)) : row)) as SpotConfig['betSizes'] }));
	timed(() => session.setRange(1, `${ip},72o`));
	// As `trueExploitabilityPercent` reads a run: the strategy in the same tree with every hand on every runout.
	const exact = createRun(defineSpot({ ...session.current.solution.spot.source, runoutBuckets: false, streetCompression: undefined }), { workers: WORKERS });
	warmStart(exact.solver.ctx, session.current.solution.solver.ctx, true);
	const exploitable = exact.exploitabilityPercent();
	exact.close();
	console.log(`${variant.padEnd(24)} | ${cells.join(' | ')} | ${exploitable.toFixed(2).padStart(8)}`);
	session.close();
}
