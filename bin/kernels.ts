/**
 * Terminal-kernel micro-benchmark.
 *
 * Purpose: time `showdownValues` and `foldValues` on their own, so a change to
 * either is judged in seconds rather than by a whole solve.
 *
 *   npm run bench:kernels
 *   npm run bench:kernels -- --calls 200000
 *
 * Uses the ranges of `bin/bench.ts` on its turn board, so every one of the 48
 * river completions is exercised, with fixed pseudo-random reach (a fraction
 * of it zero, as late in a solve). The checksum must not change when a kernel
 * is rewritten for speed.
 */

import { COMBOS } from '../src/cards.ts';
import { defineSpot } from '../src/index.ts';
import { buildShowdownTable, foldValues, makeTerminalScratch, showdownValues } from '../src/showdown.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';

const args = process.argv.slice(2);
const at = args.indexOf('--calls');
const calls = at >= 0 ? Number(args[at + 1]) : 100_000;

const spot = defineSpot({ board: 'AsKh7d2c', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.5]], maxRaises: 1 });
const relevant = new Uint8Array(COMBOS);
for (const combo of spot.players[0].combos) relevant[combo] = 1;
for (const combo of spot.players[1].combos) relevant[combo] = 1;
const table = buildShowdownTable(spot.runouts, relevant);

// Deterministic reach: a third of the hands at zero.
let seed = 0x2545f491;
const random = (): number => {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	return (seed >>> 0) / 4294967296;
};
const VARIANTS = 8;
const reaches = Array.from({ length: VARIANTS }, () => {
	const reach = new Float64Array(COMBOS);
	for (const combo of spot.players[1].combos) reach[combo] = random() < 0.33 ? 0 : random();
	return reach;
});

// Live lists per river board, for the fold kernel.
const lives = Array.from({ length: table.boards }, (_, board) => {
	const count = table.liveCount[board];
	return Uint16Array.from(table.order.subarray(board * table.stride, board * table.stride + count));
});

const scratch = makeTerminalScratch();
const out = new Float64Array(COMBOS);

function time(name: string, kernel: (call: number) => void): void {
	for (let i = 0; i < Math.min(calls, 5000); i++) kernel(i); // warm-up
	let checksum = 0;
	const started = performance.now();
	for (let i = 0; i < calls; i++) {
		kernel(i);
		checksum += out[lives[i % table.boards][i % 7]];
	}
	const ns = ((performance.now() - started) * 1e6) / calls;
	console.log(`${name.padEnd(10)} ${ns.toFixed(0).padStart(7)} ns/call   checksum ${checksum.toPrecision(12)}`);
}

console.log(`${calls} calls, ${table.boards} river boards, ~${Math.round(table.liveCount[0])} live hands per board`);
time('showdown', (i) => showdownValues(reaches[i % VARIANTS], table, i % table.boards, 1, scratch, out));
time('fold', (i) => {
	const live = lives[i % table.boards];
	foldValues(reaches[i % VARIANTS], live, live.length, 1, scratch, out);
});
