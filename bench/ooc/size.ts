/**
 * Issue #55: how T's storage splits by round, and what a river page is.
 * Run: node --import tsx bench/ooc/size.ts
 */
import { defineSpot } from '../../src/index.ts';
import { buildLayout } from '../../src/cfr.ts';
import type { SpotConfig } from '../../src/index.ts';
import { NodeKind } from '../../src/tree.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const GiB = 2 ** 30;
export const T = (board: string, extra: Partial<SpotConfig> = {}): SpotConfig => ({
	board, pot: 55, stack: 975, oop: OOP, ip: IP,
	betSizes: [[0.33, 0.75, 1.5]], raiseSizes: [[0.75]], allowAllIn: true, maxRaises: 3,
	maxBytes: 64 * GiB, ...extra,
}) as SpotConfig;

if (import.meta.url === `file://${process.argv[1]}`) for (const [name, cfg] of [
	['T  AsKh7d', T('As Kh 7d')],
	['T  Ks9s4s', T('Ks 9s 4s')],
	['T0 AsKh7d', T('As Kh 7d', { raiseSizes: ['allin'], maxRaises: 2 })],
] as const) {
	const spot = defineSpot(cfg);
	const { tree, runouts, players } = spot;
	const layout = buildLayout(tree, runouts, players, 2);
	const perRound = [0, 0, 0];
	const nodesPerRound = [0, 0, 0];
	for (const node of tree.decisionNodes) {
		const r = tree.round[node];
		nodesPerRound[r]++;
	}
	// Slots per round: walk decision nodes in order, difference of offsets.
	const dn = tree.decisionNodes;
	for (let i = 0; i < dn.length; i++) {
		const next = i + 1 < dn.length ? layout.offset[dn[i + 1]] : layout.totalSlots;
		perRound[tree.round[dn[i]]] += next - layout.offset[dn[i]];
	}
	let riverChance = 0;
	for (let n = 0; n < tree.nodeCount; n++) if (tree.kind[n] === NodeKind.Chance && tree.round[n] === 1) riverChance++;
	const b = (s: number) => ((s * 2 * 2) / GiB).toFixed(3) + ' GiB';
	console.log(name, {
		decision: nodesPerRound, runouts: Array.from(runouts.counts), combos: [players[0].count, players[1].count],
		i16: { flop: b(perRound[0]), turn: b(perRound[1]), river: b(perRound[2]), total: (spot.estimate.compressedBytes / GiB).toFixed(2) },
		f32: (spot.estimate.bytes / GiB).toFixed(2), totalSlots: layout.totalSlots, riverChanceNodes: riverChance,
		turnBoards: runouts.counts[1],
		riverPagePerTurnBoard_i16_MiB: ((perRound[2] * 4) / runouts.counts[1] / 2 ** 20).toFixed(1),
	});
}
