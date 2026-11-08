/**
 * How far R (three sizes on the flop only) is from T (three on every
 * street), by their saved references (issue #56): the floor under any
 * flop-only grafting, however well it stitches.
 *
 *   node --import tsx bench/graft/refs.ts <rainbow|monotone>
 */
import { readFileSync } from 'node:fs';
import { defineSpot } from '../../src/index.ts';
import type { SolveRun } from '../../src/index.ts';
import { rootError } from './measure.ts';
import type { Reading } from './measure.ts';
import { BOARDS, flopGame } from './spots.ts';

const name = process.argv[2];
const load = (game: string): Reading =>
	JSON.parse(readFileSync(new URL(`../../scratch/graft/${game}-${name}.json`, import.meta.url), 'utf8')) as Reading;
const [r, t] = [load('R'), load('T')];
// rootError reads only the ranges.
const run = { spot: defineSpot(flopGame(BOARDS[name])) } as SolveRun;
const err = rootError(r.root, t.root, run);
console.log(`R vs T on ${name}: root EV MAE ${err.map((e) => e.mae.toFixed(2)).join(' / ')}, max ${err.map((e) => e.max.toFixed(2)).join(' / ')}, range EV ${err.map((e) => e.range.toFixed(2)).join(' / ')} (% of pot, OOP / IP)`);
