/**
 * Checks of the grafting machinery on a small turn spot (issue #56): a piece
 * with nothing forced solves exactly like the spot itself; pieces solved for
 * the reference's own opening strategy reassemble into the reference; and
 * how each stitch converges with rounds.
 *
 *   node --import tsx bench/graft/check.ts
 */
import { createRun, defineSpot } from '../../src/index.ts';
import type { SpotConfig } from '../../src/index.ts';
import { assemble, graftSolve, pieceSpot, writeOpenings } from './graft.ts';
import type { GraftOptions } from './graft.ts';
import { read, rootError } from './measure.ts';

const common = { board: 'As Kh 7d 2c', pot: 55, stack: 400, oop: 'AA-77,AKs-A9s,KQs,AKo-AJo,KQo,76s,65s', ip: 'TT-22,AQs-A2s,KQs-KTs,QJs,JTs,T9s,AQo-ATo', raiseSizes: [[0.75]], allowAllIn: true, maxRaises: 2 };
const R = { ...common, betSizes: [[0.33, 0.75, 1.5], [0.75]] } as unknown as SpotConfig;
const base = { ...common, betSizes: [[0.75]] } as unknown as SpotConfig;
const workers = Number(process.env.WORKERS ?? 1);

{
	const spot = defineSpot(R);
	const a = createRun(spot, { workers: 1 });
	const b = createRun(pieceSpot(R, new Map(), spot.players[0].weights, spot.players[1].weights), { workers: 1 });
	a.step(20);
	b.step(20);
	console.log('unforced piece: exploitability', a.exploitabilityPercent(), b.exploitabilityPercent());
	a.close();
	b.close();
}

const ref = createRun(defineSpot(R), { workers });
let t = performance.now();
ref.step(300);
console.log(`direct solve of R: 300 iterations, ${((performance.now() - t) / 1000).toFixed(1)} s, ${ref.exploitabilityPercent().toFixed(3)}%`);
ref.step(300);
console.log('reference exploitability', ref.exploitabilityPercent().toFixed(3));
const refReading = read(ref);
const seed = refReading.openings.map((o) => o.probs.map((p) => Float64Array.from(p, (x) => (Number.isNaN(x) ? 0 : x)))) as [Float64Array[], Float64Array[]];

const trial = (label: string, options: Omit<GraftOptions, 'onLastRound' | 'base' | 'workers'>): void => {
	const analysis = createRun(defineSpot(R), { analysisOnly: true });
	const result = graftSolve(R, { ...options, base, workers, onLastRound: (run) => assemble(analysis.solver.ctx, run) });
	writeOpenings(analysis.solver.ctx, result);
	const reading = read(analysis);
	const err = rootError(reading.root, refReading.root, ref);
	console.log(
		`${label}: exploitability in R ${analysis.exploitabilityPercent().toFixed(3)}%, root EV MAE ${err.map((e) => e.mae.toFixed(3)).join('/')}, max ${err.map((e) => e.max.toFixed(3)).join('/')}, ${(result.totalMs / 1000).toFixed(1)} s`,
	);
};
trial('seeded with the reference, 1 round', { rounds: 1, pieceIterations: 600, baseIterations: 0, seed });
for (const play of ['current', 'average'] as const)
	for (const rounds of [4, 16, 64]) trial(`${play}, ${rounds} rounds`, { rounds, pieceIterations: 200, baseIterations: 200, play });
