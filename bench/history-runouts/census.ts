/**
 * Storage census by betting line (issue #53, step 1).
 *
 *   node --import tsx bench/history-runouts/census.ts [--spot T|T0|M|M0]
 *
 * Classifies every decision node by the betting before the last card dealt
 * to it — the history a per-subtree runout set could key on — and sums its
 * storage. A river node's storage is set by the turn and river cards below
 * the chance nodes above it, so only the flop and turn betting can choose how
 * coarse those are; river raises happen on a board already dealt.
 */

import { defineSpot } from '../../src/index.ts';
import { buildActiveLists } from '../../src/cfr.ts';
import { ActionKind, NodeKind } from '../../src/tree.ts';
import { SPOTS } from './spots.ts';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : fallback;
};

for (const name of opt('spot', 'T,T0,M').split(',')) {
	const spot = defineSpot({ ...SPOTS[name], maxBytes: 2 ** 40 });
	const { tree, runouts, players } = spot;
	// Counted in floats: T's slot count overflows the layout's Int32 offsets.
	const active = buildActiveLists(runouts, players);
	const live = new Float64Array(runouts.rounds * 2);
	for (let r = 0; r < runouts.rounds; r++) {
		for (let b = 0; b < runouts.counts[r]; b++) {
			for (let p = 0; p < 2; p++) live[r * 2 + p] += active.count[(active.roundBase[r] + b) * 2 + p];
		}
	}
	const nodeBytes = new Float64Array(tree.nodeCount);
	const order = Array.from(tree.decisionNodes);
	// i16: two accumulators of two bytes each.
	for (const n of order) nodeBytes[n] = tree.numEdges[n] * live[tree.round[n] * 2 + tree.player[n]] * 4;
	// Per class: bytes by street. Class = raises (aggression facing a bet) on
	// earlier streets; and separately aggressions (bets + raises) on earlier streets.
	const byRaise = new Map<string, number[]>();
	const byAggr = new Map<string, number[]>();
	const add = (map: Map<string, number[]>, key: string, street: number, bytes: number): void => {
		if (!map.has(key)) map.set(key, [0, 0, 0]);
		map.get(key)![street] += bytes;
	};
	const walk = (node: number, raises: number, aggr: number, streetRaises: number, streetAggr: number): void => {
		const kind = tree.kind[node];
		if (kind === NodeKind.TerminalFold || kind === NodeKind.TerminalShowdown) return;
		if (kind === NodeKind.Chance) {
			walk(tree.edgeChild[tree.firstEdge[node]], raises + streetRaises, aggr + streetAggr, 0, 0);
			return;
		}
		const street = tree.round[node];
		add(byRaise, raises >= 2 ? '2+' : String(raises), street, nodeBytes[node]);
		add(byAggr, aggr >= 3 ? '3+' : String(aggr), street, nodeBytes[node]);
		for (let e = 0; e < tree.numEdges[node]; e++) {
			const a = tree.edgeAction[tree.firstEdge[node] + e];
			const child = tree.edgeChild[tree.firstEdge[node] + e];
			const aggressive = a === ActionKind.Bet || a === ActionKind.Raise || a === ActionKind.AllIn;
			const facing = streetAggr > 0;
			walk(child, raises, aggr, streetRaises + (aggressive && facing ? 1 : 0), streetAggr + (aggressive ? 1 : 0));
		}
	};
	walk(0, 0, 0, 0, 0);
	const total = order.reduce((s, n) => s + nodeBytes[n], 0);
	const gib = (b: number): string => `${(b / 2 ** 30).toFixed(2)} GiB`;
	const pc = (b: number): string => `${((100 * b) / total).toFixed(1)}%`;
	console.log(`\n${name}: ${spot.source.board}, ${tree.decisionNodes.length} decisions, i16 storage ${gib(total)} (f32 ${gib(total * 2)})`);
	console.log(`  boards: ${runouts.counts.join(' / ')}`);
	for (const [label, map] of [['raises before the last card', byRaise], ['aggressions before the last card', byAggr]] as const) {
		console.log(`  by ${label}:`);
		for (const key of [...map.keys()].sort()) {
			const row = map.get(key)!;
			const sum = row[0] + row[1] + row[2];
			console.log(`    ${key.padEnd(3)} ${gib(sum).padStart(10)} ${pc(sum).padStart(7)}   flop ${pc(row[0])}  turn ${pc(row[1])}  river ${pc(row[2])}`);
		}
	}
}
