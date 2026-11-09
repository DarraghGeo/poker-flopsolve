/**
 * Issue #103: the results tables, from `results/cross-check-*.json` and
 * `results/options-*.json`, as Markdown.
 *
 *   node --import tsx bench/reference/summary.ts
 */

import { readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('results/', import.meta.url);
const read = (name: string): any => JSON.parse(readFileSync(new URL(name, DIR), 'utf8'));
const f = (x: number | null | undefined, digits = 3): string => (x === null || x === undefined || Number.isNaN(x) ? '—' : x.toFixed(digits));
const texture = (board: string): string => {
	const cards = board.split(' ');
	const suits = new Set(cards.map((c) => c[1])).size;
	const paired = new Set(cards.map((c) => c[0])).size < 3;
	return (suits === 1 ? 'monotone' : suits === 2 ? 'two-tone' : 'rainbow') + (paired ? ', paired' : '');
};

const files = readdirSync(DIR);
const cross = files.filter((n) => /^cross-check-.*\.json$/.test(n)).sort().map(read);
console.log('## Cross-check: exact solves against the stored regrets\n');
console.log('Regret error = |(EV(a) − EV(best)) ours − stored| per hand, reach-weighted, % of the node pot. "Played" weights each action by the larger of the two solvers\' probability of it; "all actions" includes actions neither plays (off-path values).\n');
console.log('| Spot | Board | Texture | Pot | f32 GiB | Iterations | Exploitability | Time | Flop played: mean / worst node | Turn played: mean / worst node | All actions: flop / turn mean | Root loss at stored EVs, OOP / IP (stored strategy\'s own) |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const c of cross) {
	const s = c.summary;
	console.log(
		`| ${c.id} | ${c.board} | ${texture(c.board)} | ${c.potType} | ${f(c.bytes / 2 ** 30, 2)} | ${c.iterations} | ${f(c.exploitability)}% | ${Math.round(c.seconds)} s | ` +
			`${f(s.flopPlayedError)} / ${f(s.flopWorstPlayed)} | ${f(s.turnPlayedError)} / ${f(s.turnWorstPlayed)} | ${f(s.flopMeanError, 2)} / ${f(s.turnMeanError, 2)} | ` +
			`${f(s.rootLossOop)} / ${f(s.rootLossIp)} (${f(s.rootRefLossOop)} / ${f(s.rootRefLossIp)}) |`,
	);
}

const options = files.filter((n) => /^options-.*\.json$/.test(n)).sort();
if (options.length) {
	const all = options.map((n) => [n.slice(8, -5), read(n)] as const);
	const variants = [...new Set(all.flatMap(([, r]) => Object.keys(r)))];
	console.log('\n## Each option on the napkinpoker sample\n');
	console.log('EV lost at the stored per-action EVs, % of the node pot, at as many iterations as the exact solve took to 0.3%. Root: OOP at the flop root / IP after a check. Flop and turn: mean over the scored nodes. Means over the spots.\n');
	console.log('| Option | Spots | Storage vs exact | Time vs exact | Root loss OOP / IP | Flop nodes | Turn nodes | Re-solved turns | True exploitability |');
	console.log('|---|---|---|---|---|---|---|---|---|');
	for (const v of variants) {
		const rows = all.filter(([, r]) => r[v] && r.exact);
		if (!rows.length) continue;
		const avg = (pick: (r: any, e: any) => number): number => rows.reduce((s, [, r]) => s + pick(r[v], r.exact), 0) / rows.length;
		const resolved = rows.every(([, r]) => r[v].resolved);
		console.log(
			`| ${v} | ${rows.length} | ${f(avg((r, e) => r.bytes / e.bytes), 2)}× | ${f(avg((r, e) => r.solveSeconds / e.solveSeconds), 2)}× | ` +
				`${f(avg((r) => r.rootOop?.loss ?? NaN))} / ${f(avg((r) => r.rootIp?.loss ?? NaN))} | ${f(avg((r) => r.flop.loss))} | ${f(avg((r) => r.turn.loss))} | ` +
				`${resolved ? f(avg((r) => r.resolved.summary.loss)) : '—'} | ${f(avg((r) => r.trueExploitability), 2)}% |`,
		);
	}
	console.log('\nThe stored strategy\'s own loss at the same nodes (noise floor): ' +
		`root ${f(all.reduce((s, [, r]) => s + r.exact.rootOop.ref, 0) / all.length)} / ${f(all.reduce((s, [, r]) => s + r.exact.rootIp.ref, 0) / all.length)}, ` +
		`flop ${f(all.reduce((s, [, r]) => s + r.exact.flop.refLoss, 0) / all.length)}, turn ${f(all.reduce((s, [, r]) => s + r.exact.turn.refLoss, 0) / all.length)}.`);
}
