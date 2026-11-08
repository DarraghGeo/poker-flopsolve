import { defineSpot } from '../../src/index.ts';
import type { SpotConfig } from '../../src/index.ts';
import { NodeKind } from '../../src/tree.ts';
import { buildLayout } from '../../src/cfr.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const base = { board: 'As Kh 7d', pot: 55, stack: 975, oop: OOP, ip: IP, maxBytes: 2 ** 50 } as const;
const variants: Record<string, Partial<SpotConfig>> = {
	T: { betSizes: [[0.33, 0.75, 1.5]], raiseSizes: [[0.75]], allowAllIn: true, maxRaises: 3 },
	T0: { betSizes: [[0.33, 0.75, 1.5]], raiseSizes: ['allin'], allowAllIn: true, maxRaises: 2 },
};
const GiB = 2 ** 30;
for (const [name, v] of Object.entries(variants)) {
	const spot = defineSpot({ ...base, ...v } as SpotConfig);
	const { tree, runouts, players } = spot;
	const layout = buildLayout(tree, runouts, players, 4);
	// aggression count within round, by walking
	const byRound = [0, 0, 0];
	const byRoundAgg: Record<string, number> = {};
	const nodesByRound = [0, 0, 0];
	const walk = (node: number, agg: number, pathAgg: number) => {
		const k = tree.kind[node];
		if (k === NodeKind.Decision) {
			const next = node + 0;
			const r = tree.round[node];
			const slots = (layout.offset[next] >= 0) ? tree.numEdges[node] : 0;
			// slots of this node
			let size = 0;
			// compute size from layout: next decision offset difference is unreliable; recompute
			size = slots;
			nodesByRound[r]++;
			const key = `r${r} agg${agg} prior${pathAgg}`;
			const bytes = sizes.get(node)!;
			byRound[r] += bytes;
			byRoundAgg[key] = (byRoundAgg[key] ?? 0) + bytes;
			for (let e = 0; e < tree.numEdges[node]; e++) {
				const edge = tree.firstEdge[node] + e;
				const a = tree.edgeAction[edge];
				walk(tree.edgeChild[edge], a >= 3 ? agg + 1 : agg, pathAgg);
			}
		} else if (k === NodeKind.Chance) {
			walk(tree.edgeChild[tree.firstEdge[node]], 0, pathAgg + agg);
		}
	};
	const sizes = new Map<number, number>();
	// rows per (round, player): rowStart is cumulative within a round
	const rows = (r: number, p: number): number => {
		const last = layout.roundBase[r + 1] - 1;
		// live of last board is unknown from layout alone; approximate with mean of others
		const n = layout.roundBase[r + 1] - layout.roundBase[r];
		const startLast = layout.rowStart[last * 2 + p];
		return n === 1 ? players[p].count : startLast * n / (n - 1);
	};
	for (const node of tree.decisionNodes) sizes.set(node, tree.numEdges[node] * rows(tree.round[node], tree.player[node]) * 8);
	walk(0, 0, 0);
	console.log(name, 'total f32', (spot.estimate.bytes / GiB).toFixed(2), 'GiB, nodes', tree.decisionNodes.length, nodesByRound);
	console.log(' by round GiB', byRound.map((b) => (b / GiB).toFixed(3)));
	const top = Object.entries(byRoundAgg).sort((a, b) => b[1] - a[1]).slice(0, 25);
	for (const [k, b] of top) console.log('  ', k, (b / GiB).toFixed(3));
}
