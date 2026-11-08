/**
 * Storage a history-dependent runout set would leave (issue #53), before any
 * solving: every decision node's storage scaled by how many boards its line
 * keeps at its round. A coarse chance node keeps one stored card per class of
 * `classKey`; the rest of the deck plays as one of those.
 *
 *   node --import tsx bench/history-runouts/plan.ts [--spot T,M]
 */

import { defineSpot } from '../../src/index.ts';
import { buildActiveLists } from '../../src/cfr.ts';
import { connectivity } from '../../src/runouts.ts';
import { ActionKind, NodeKind } from '../../src/tree.ts';
import { SPOTS } from './spots.ts';

/** A card's class on a board: what it does to pairs, flushes and straights, and a rank band. */
export function classKey(board: readonly number[], card: number, band: number): string {
	const ranks = new Set(board.map((c) => c >> 2));
	const rank = card >> 2;
	const suit = card & 3;
	const suited = board.filter((c) => (c & 3) === suit).length;
	const pairs = ranks.has(rank) ? 1 : 0;
	const straight = connectivity(ranks, rank);
	// Paired ranks keep their rank: trips and boats differ too much.
	return `${pairs ? `p${rank}` : `b${Math.floor(rank / band)}`}:s${Math.min(suited, 4)}:c${straight}`;
}

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : fallback;
};

const DECK = 52;
const classes = (board: number[], band: number): number[][] => {
	const used = new Set(board);
	const by = new Map<string, number[]>();
	for (let c = 0; c < DECK; c++) {
		if (used.has(c)) continue;
		const key = classKey(board, c, band);
		if (!by.has(key)) by.set(key, []);
		by.get(key)!.push(c);
	}
	return [...by.values()];
};

for (const name of opt('spot', 'T,M').split(',')) {
	const spot = defineSpot({ ...SPOTS[name], maxBytes: 2 ** 40 });
	const { tree, runouts, players } = spot;
	const active = buildActiveLists(runouts, players);
	const live = new Float64Array(runouts.rounds * 2);
	for (let r = 0; r < runouts.rounds; r++) {
		for (let b = 0; b < runouts.counts[r]; b++) {
			for (let p = 0; p < 2; p++) live[r * 2 + p] += active.count[(active.roundBase[r] + b) * 2 + p] / runouts.counts[r];
		}
	}
	const flop = [...runouts.initial];
	console.log(`\n${name} ${spot.source.board}: boards ${runouts.counts.join('/')}`);
	for (const band of [1, 2, 3, 4, 13]) {
		// Boards kept: fine F, coarse C at the turn; FF, FC, CC at the river.
		// Fine boards as the spot stores them, mirror images folded.
		const turnFine = Array.from({ length: runouts.counts[1] }, (_, b) => runouts.cards[1][b * 4 + 3]);
		const turnCoarse = classes(flop, band).map((c) => c[Math.floor(c.length / 2)]);
		const rivers = (turns: number[]): number => turns.reduce((s, t) => s + classes([...flop, t], band).length, 0);
		const sizes = { F: turnFine.length, C: turnCoarse.length, FF: runouts.counts[2], FC: rivers(turnFine), CC: rivers(turnCoarse) };
		for (const rule of ['raise>=1', 'raise>=2', 'aggr>=2', 'aggr>=3', 'all']) {
			const coarseAt = (raises: number, aggr: number): boolean =>
				rule === 'all' ? true : rule.startsWith('raise') ? raises >= Number(rule.slice(-1)) : aggr >= Number(rule.slice(-1));
			let bytes = 0;
			const walk = (node: number, fam: string, raises: number, aggr: number, sr: number, sa: number): void => {
				const kind = tree.kind[node];
				if (kind === NodeKind.TerminalFold || kind === NodeKind.TerminalShowdown) return;
				if (kind === NodeKind.Chance) {
					const r = raises + sr;
					const a = aggr + sa;
					const coarse = coarseAt(r, a) || fam.endsWith('C');
					walk(tree.edgeChild[tree.firstEdge[node]], fam + (coarse ? 'C' : 'F'), r, a, 0, 0);
					return;
				}
				const round = tree.round[node];
				const boards = round === 0 ? 1 : sizes[fam as keyof typeof sizes];
				bytes += tree.numEdges[node] * live[round * 2 + tree.player[node]] * boards * 4;
				for (let e = 0; e < tree.numEdges[node]; e++) {
					const action = tree.edgeAction[tree.firstEdge[node] + e];
					const aggressive = action === ActionKind.Bet || action === ActionKind.Raise || action === ActionKind.AllIn;
					walk(tree.edgeChild[tree.firstEdge[node] + e], fam, raises, aggr, sr + (aggressive && sa > 0 ? 1 : 0), sa + (aggressive ? 1 : 0));
				}
			};
			walk(0, '', 0, 0, 0, 0);
			console.log(
				`  band ${String(band).padStart(2)} ${rule.padEnd(9)} turn F${sizes.F}/C${sizes.C} river FF${sizes.FF}/FC${sizes.FC}/CC${sizes.CC}` +
					`  i16 ${(bytes / 2 ** 30).toFixed(2)} GiB  f32 ${((2 * bytes) / 2 ** 30).toFixed(2)} GiB`,
			);
		}
	}
}
