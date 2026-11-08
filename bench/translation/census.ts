/**
 * Experiment 1 of issue #54: where T's storage sits, by the bet a raise
 * follows. Each decision node's bytes (32-bit, as `estimate.bytes` counts
 * them) are charged to the innermost raise above it on its own street — or
 * to "no raise" — keyed by the size of the bet that raise answered.
 *
 *   node --import tsx bench/translation/census.ts [board]
 */
import { defineSpot } from '../../src/index.ts';
import { liveRows } from './lib.ts';
import { ActionKind, NodeKind } from '../../src/tree.ts';
import { targetSpot } from './spots.ts';

const board = process.argv[2] ?? 'As Kh 7d';
const spot = defineSpot({ ...targetSpot(board), maxBytes: 64 * 2 ** 30 });
const { tree, runouts, players } = spot;

const bytes = new Map<string, number>();
const add = (key: string, b: number): void => void bytes.set(key, (bytes.get(key) ?? 0) + b);
// Live rows per (round, player), summed over stored boards: what a node of
// that round and owner stores per action. Recounted here because the layout's
// Int32 offsets overflow on a tree this size.
const live = liveRows(runouts, players);
const slotsOf = (node: number): number => tree.numEdges[node] * live[tree.round[node] * 2 + tree.player[node]];

const street = ['flop', 'turn', 'river'];
const fraction = (node: number, edge: number): string => {
	const pot = tree.pot[node];
	const target = tree.edgeTarget[edge];
	// The bettor opened the round, so their target minus what they had in is the bet.
	return `${((target - (pot - spot.potUnits) / 2) / pot).toFixed(2)}`;
};

// tag: label of the innermost raise context on this street.
const walk = (node: number, tag: string, betLabel: string): void => {
	const k = tree.kind[node];
	if (k === NodeKind.Chance) {
		for (let e = tree.firstEdge[node]; e < tree.firstEdge[node] + tree.numEdges[node]; e++) walk(tree.edgeChild[e], tag, '');
		return;
	}
	if (k !== NodeKind.Decision) return;
	add(`${street[tree.round[node]]} node | first raise: ${tag}`, slotsOf(node) * 4 * 2);
	for (let e = tree.firstEdge[node]; e < tree.firstEdge[node] + tree.numEdges[node]; e++) {
		const a = tree.edgeAction[e];
		const child = tree.edgeChild[e];
		if (a === ActionKind.Bet) walk(child, tag, fraction(node, e));
		else if (a === ActionKind.AllIn && betLabel === '') walk(child, tag, 'allin');
		else if (a === ActionKind.Raise) walk(child, tag === 'no raise' ? `${street[tree.round[node]]} raise over ${betLabel}` : tag, betLabel);
		else walk(child, tag, betLabel);
	}
};
walk(0, 'no raise', '');

const total = [...bytes.values()].reduce((a, b) => a + b, 0);
console.log(`${board}: ${(spot.estimate.bytes / 2 ** 30).toFixed(2)} GiB f32 estimate, decision storage ${(total / 2 ** 30).toFixed(2)} GiB`);
for (const [key, b] of [...bytes.entries()].sort()) {
	console.log(`${key.padEnd(48)} ${(b / 2 ** 30).toFixed(3).padStart(8)} GiB  ${((100 * b) / total).toFixed(1).padStart(5)}%`);
}
