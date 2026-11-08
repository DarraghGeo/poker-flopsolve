/**
 * History-merging census (issue #49, step 1).
 *
 * Purpose: before sharing any storage, count how much of it betting histories
 * that reach the same turn or river state could share.
 *
 *   node --import tsx bench/history-merge/census.ts [--spots T,T-mono,T0]
 *
 * A round root is the first decision of a turn or river: the child of a
 * chance node. Two round roots can share storage node by node when their
 * subtrees have the same shape — the same kinds, players and actions in the
 * same order — so a key picks which roots share:
 *
 * - exact: the subtrees are identical, amounts and payoffs included. Equal
 *   investments give equal trees, so this is "same pot and stack". Lossless
 *   in tree shape; the ranges arriving still differ, so it is not lossless
 *   in strategy.
 * - spr w: same action shape, amounts ignored, and SPR in one log-width-w
 *   bucket (`floor(ln(spr) / ln(1 + w))`). Lossy: payoffs differ too.
 *
 * Storage counts every decision node's block (actions × live hands × boards)
 * once per distinct node after aliasing. "river" shares river roots only and
 * keeps the turn exact; "turn+river" shares turn roots, then river roots.
 */

import { defineSpot } from '../../src/index.ts';
import { buildLayout } from '../../src/cfr.ts';
import type { SpotConfig } from '../../src/index.ts';
import { aliasHistories } from '../../src/history-merge.ts';
import type { HistoryKey } from '../../src/history-merge.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const T = {
	pot: 55, stack: 975, oop: OOP, ip: IP, betSizes: [[0.33, 0.75, 1.5]], raiseSizes: [[0.75]],
	allowAllIn: true, maxRaises: 3, maxBytes: 2 ** 40,
};
const SPOTS: Record<string, SpotConfig> = {
	T: { board: 'As Kh 7d', ...T } as SpotConfig,
	'T-mono': { board: 'Ks 9s 4s', ...T } as SpotConfig,
	T0: { board: 'As Kh 7d', ...T, raiseSizes: [['allin']], maxRaises: 2 } as SpotConfig,
};

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : fallback;
};
const GiB = 2 ** 30;
const fmt = (bytes: number): string => (bytes >= GiB ? `${(bytes / GiB).toFixed(2)} GiB` : `${(bytes / 2 ** 20).toFixed(0)} MiB`);

for (const name of opt('spots', 'T,T-mono,T0').split(',')) {
	const spot = defineSpot(SPOTS[name]);
	const { tree, runouts, players } = spot;
	const showdown = spot.estimate.bytes - spot.estimate.totalSlots * 8;
	console.log(`\n## ${name}: ${spot.source.board}, ${tree.decisionNodes.length} decision nodes, ${runouts.counts[runouts.rounds - 1]} runouts`);
	console.log(`unshared f32 ${fmt(spot.estimate.bytes)}, i16 ${fmt(spot.estimate.compressedBytes)}`);
	console.log('| key | rounds shared | turn roots | river roots | f32 both | f32 regrets only | i16 both | factor |');
	console.log('|---|---|---|---|---|---|---|---|');
	const keys: HistoryKey[] = [{ kind: 'exact' }, ...[0.1, 0.25, 0.5, 1, 4].map((width) => ({ kind: 'spr', width }) as const)];
	for (const key of keys) {
		for (const from of [2, 1]) {
			const share = aliasHistories(tree, runouts, { key, fromRound: from }, spot.stackUnits);
			const f32 = buildLayout(tree, runouts, players, 4, share.alias).bytes + showdown;
			const regretsOnly = (f32 - showdown) / 2 + spot.estimate.totalSlots * 4 + showdown;
			const i16 = buildLayout(tree, runouts, players, 2, share.alias).bytes + showdown;
			const label = key.kind === 'exact' ? 'exact' : `spr ${key.width}`;
			const roots = (r: number): string => `${share.roots[r]} → ${share.groups[r]}`;
			console.log(
				`| ${label} | ${from === 2 ? 'river' : 'turn+river'} | ${from === 1 ? roots(1) : '–'} | ${roots(2)} | ` +
					`${fmt(f32)} | ${fmt(regretsOnly)} | ${fmt(i16)} | ${(spot.estimate.bytes / f32).toFixed(2)}× |`,
			);
		}
	}
}
