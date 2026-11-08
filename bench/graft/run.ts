/**
 * Flop-only strategy grafting on the issue's spots (issue #56), measured
 * against the references `reference.ts` saved.
 *
 *   node --import tsx bench/graft/run.ts <rainbow|monotone> <rounds> <pieceIterations> [average|current] [baseIterations]
 *
 * Reports peak storage, wall time, exploitability of the stitched strategy in
 * R (the game it approximates; it has no strategy for T's turn and river
 * sizes), per-combination root-EV error against R's and T's references, and
 * at the two opening decisions, per-hand EV error at each size and whether
 * the preferred size agrees.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { COMBOS, createRun, defineSpot } from '../../src/index.ts';
import { assemble, graftSolve, writeOpenings } from './graft.ts';
import { read, rootError } from './measure.ts';
import type { Opening, Reading } from './measure.ts';
import { baseGame, BOARDS, flopGame } from './spots.ts';

const [boardName, roundsArg, iterationsArg, playArg, baseArg] = process.argv.slice(2);
const board = BOARDS[boardName];
const config = flopGame(board);
const rounds = Number(roundsArg);
const pieceIterations = Number(iterationsArg);
const play = (playArg ?? 'average') as 'average' | 'current';
const baseIterations = Number(baseArg ?? 0);

// R's strategy sums, to assemble the pieces into and measure: measurement
// only, not part of the method, and not in the peak it reports.
const analysis = createRun(defineSpot(config), { analysisOnly: true });
let assembleMs = 0;
const result = graftSolve(config, {
	rounds, pieceIterations, play, baseIterations, base: baseGame(board), workers: 4,
	onPiece: (p) => console.log(`  round ${p.round} ${p.piece.padEnd(8)} ${(p.ms / 1000).toFixed(1)} s, ${(p.bytes / 2 ** 20).toFixed(0)} MiB`),
	onLastRound: (run) => {
		const t = performance.now();
		assemble(analysis.solver.ctx, run);
		assembleMs += performance.now() - t;
	},
});
writeOpenings(analysis.solver.ctx, result);
const seconds = (result.totalMs - assembleMs) / 1000;
const exploit = analysis.exploitabilityPercent();
const mine = read(analysis);

/** Per-hand EV error at each bet size, and how often the preferred size agrees, weighted by reach. */
function sizes(a: Opening, b: Opening): { mae: Record<string, number>; agree: number } {
	const sized = a.actions.map((label, i) => [label, i] as const).filter(([label]) => label !== 'check' && label !== 'allin');
	const mae: Record<string, number> = {};
	for (const [label, i] of sized) {
		let sum = 0;
		let mass = 0;
		const j = b.actions.indexOf(label);
		if (j < 0) throw new Error(`the reference has no ${label} bet`);
		for (let h = 0; h < COMBOS; h++) {
			const w = b.reach[h];
			if (!(w > 0) || Number.isNaN(a.evs[i][h]) || Number.isNaN(b.evs[j][h])) continue;
			sum += w * Math.abs(a.evs[i][h] - b.evs[j][h]);
			mass += w;
		}
		mae[label] = sum / mass;
	}
	let agree = 0;
	let mass = 0;
	for (let h = 0; h < COMBOS; h++) {
		const w = b.reach[h];
		if (!(w > 0) || Number.isNaN(a.evs[0][h])) continue;
		const best = (o: Opening): string => {
			let top = '';
			let value = -Infinity;
			for (const [label] of sized) {
				const v = o.evs[o.actions.indexOf(label)][h];
				if (v > value) [top, value] = [label, v];
			}
			return top;
		};
		const [mine, theirs] = [best(a), best(b)];
		if (mine === '' || theirs === '') continue;
		mass += w;
		if (mine === theirs) agree += w;
	}
	return { mae, agree: agree / mass };
}

const out: Record<string, unknown> = {
	board: boardName, rounds, pieceIterations, play, baseIterations, seconds,
	peakMiB: result.peakBytes / 2 ** 20, exploitabilityInR: exploit,
};
console.log(
	`${boardName}: ${rounds} rounds x ${pieceIterations} iterations (${play}, blueprint ${baseIterations}): ` +
		`${seconds.toFixed(0)} s, peak ${(result.peakBytes / 2 ** 20).toFixed(0)} MiB f32, exploitability in R ${exploit.toFixed(2)}% of pot`,
);
for (const game of ['R', 'T']) {
	const file = new URL(`../../scratch/graft/${game}-${boardName}.json`, import.meta.url);
	if (!existsSync(file)) continue;
	const ref = JSON.parse(readFileSync(file, 'utf8')) as Reading & { exploitability: number };
	const err = rootError(mine.root, ref.root, analysis);
	const open = [0, 1].map((d) => sizes(mine.openings[d], ref.openings[d]));
	out[game] = { err, open };
	console.log(
		`  vs ${game} (${ref.exploitability.toFixed(2)}%): root EV MAE ${err.map((e) => e.mae.toFixed(2)).join(' / ')}, ` +
			`max ${err.map((e) => e.max.toFixed(2)).join(' / ')}, range EV ${err.map((e) => e.range.toFixed(2)).join(' / ')} (% of pot, OOP / IP)`,
	);
	for (const [d, name] of [[0, 'OOP root'], [1, 'IP after check']] as const) {
		const o = open[d];
		console.log(
			`    ${name}: per-hand EV error at ${Object.entries(o.mae).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}; preferred size agrees ${(100 * o.agree).toFixed(0)}%`,
		);
	}
}
mkdirSync(new URL('../../scratch/graft/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../../scratch/graft/run-${boardName}-${rounds}-${pieceIterations}-${play}-${baseIterations}.json`, import.meta.url), JSON.stringify(out));
