/**
 * What a solve costs before it is solving: loading the package, defining
 * the spot, creating the run, and the first iteration against the second.
 *
 *   npm run build
 *   node --import tsx bench/startup/measure.ts [dist directory,...] [case,...] [prepare]
 *
 * Each case runs in `PROCESSES` (default 5) new Node processes
 * (`bench/startup/child.js`), four times in each. `cold` is the first time
 * in a process, nothing compiled or kept; `hot` is the median of the rest,
 * each with another pot, as a page solving its next spot would have. The
 * table gives the median over the processes, in milliseconds:
 * - `load`: importing the package;
 * - `define`: `defineSpot` (and `litePreset` for the Lite cases);
 * - `create`: `createRun`;
 * - `first`: the first iteration, and `second` the one after, for what the
 *   first costs over an ordinary one;
 * - `ready`: define, create and the first iteration together, less an
 *   ordinary iteration: what stands between the call and solving.
 *
 * Give two build directories to compare them, e.g. a build of `staging`
 * beside `dist`. `prepare` calls `enableThreads(4)` first.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dirArg, caseArg, prepare] = process.argv.slice(2);
const dirs = (dirArg ?? 'dist').split(',').map((dir) => resolve(dir));
const cases = (caseArg ?? 'river,turn,flop,flop-4t,lite-rainbow-4t,lite-two-tone-4t,lite-monotone-4t').split(',');
const PROCESSES = Number(process.env.PROCESSES ?? 5);
const child = fileURLToPath(new URL('./child.js', import.meta.url));

interface Row { define: number; create: number; first: number; second: number }
interface Result { load: number; rows: Row[] }

const median = (values: number[]): number => values.slice().sort((a, b) => a - b)[values.length >> 1];
const cell = (value: number): string => value.toFixed(1).padStart(8);

console.log(`case              build     load |  cold: define   create    first   second    ready |   hot: define   create    first   second    ready`);
for (const name of cases) {
	for (const dir of dirs) {
		const results: Result[] = Array.from({ length: PROCESSES }, () =>
			JSON.parse(execFileSync('node', [child, dir, name, '4', ...(prepare ? ['prepare'] : [])]).toString()) as Result);
		const ready = (row: Row): number => row.define + row.create + row.first - row.second;
		const hot = (pick: (row: Row) => number): number => median(results.map((result) => median(result.rows.slice(1).map(pick))));
		const cold = (pick: (row: Row) => number): number => median(results.map((result) => pick(result.rows[0])));
		const row = (of: (pick: (row: Row) => number) => number): string =>
			[of((r) => r.define), of((r) => r.create), of((r) => r.first), of((r) => r.second), of(ready)].map(cell).join(' ');
		console.log(`${name.padEnd(17)} ${dir.split('/').slice(-1)[0].padEnd(9)} ${cell(median(results.map((r) => r.load)))} | ${row(cold)}        | ${row(hot)}`);
	}
}
