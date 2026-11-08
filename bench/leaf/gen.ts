/**
 * Training data for the turn-leaf experiment: random turn spots, ranges
 * sampled around archetypes, solved to 0.3% of pot, one row per combo.
 *
 *   node --import tsx bench/leaf/gen.ts <seed> <spots> <out.jsonl>
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { createRun, defineSpot, formatCards } from '../../src/index.ts';
import { ARCHETYPES, comboEv, parse, rng, rowsFor, sampleRange } from './lib.ts';

const [seedArg, countArg, out] = process.argv.slice(2);
const seed = Number(seedArg);
const next = rng(seed * 7919 + 13);
const names = Object.keys(ARCHETYPES);
// The two leaf geometries a flop tree with a half-pot bet and no raise has.
const GEOMETRIES = [{ pot: 100, stack: 200 }, { pot: 200, stack: 150 }];
writeFileSync(out, '');
const t0 = performance.now();
let skipped = 0;
for (let i = 0; i < Number(countArg); i++) {
	const id = seed * 100000 + i;
	const deck = Array.from({ length: 52 }, (_, c) => c);
	const board: number[] = [];
	while (board.length < 4) board.push(deck.splice(Math.floor(next() * deck.length), 1)[0]);
	const baseO = parse(ARCHETYPES[names[Math.floor(next() * names.length)]]);
	const baseI = parse(ARCHETYPES[names[Math.floor(next() * names.length)]]);
	const o = sampleRange(next, baseO, board, baseI);
	const p = sampleRange(next, baseI, board, baseO);
	const g = GEOMETRIES[Math.floor(next() * GEOMETRIES.length)];
	let spot;
	try {
		spot = defineSpot({ board: formatCards(board), ...g, oop: o.weights, ip: p.weights, betSizes: [[0.5]], maxRaises: 1 });
	} catch (error) {
		// A range the board empties is skipped; anything else is a bug.
		if (!String(error).includes('empty once the board is removed')) throw error;
		skipped++;
		continue;
	}
	const run = createRun(spot);
	let it = 0, e = Infinity;
	while (it < 600) {
		run.step(10);
		it += 10;
		e = run.exploitabilityPercent();
		if (e < 0.3) break;
	}
	const reach = [Float64Array.from(spot.players[0].weights), Float64Array.from(spot.players[1].weights)] as const;
	const ev = [0, 1].map((pl) => comboEv(run, 0, 0, pl as 0 | 1, reach[pl], reach[1 - pl], board).ev) as [Float64Array, Float64Array];
	run.close();
	const rows = rowsFor(id, board, g.pot, g.stack, reach, ev);
	appendFileSync(out, JSON.stringify({ id, board: formatCards(board), ...g, modes: [o.mode, p.mode], iterations: it, exploit: e, rows }) + '\n');
}
console.log(`seed ${seed}: ${Number(countArg) - skipped} spots (${skipped} skipped) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
