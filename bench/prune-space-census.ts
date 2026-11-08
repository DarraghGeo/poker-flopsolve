/**
 * Storage census for pruning for space (issue #52, step 1).
 *
 * Purpose: before building any freeing of storage, measure how much of it sits
 * below lines that no hand plays, the way #26's `bench/prune-census.ts`
 * measured work.
 *
 *   node --import tsx bench/prune-space-census.ts [--spots T0] [--iters 100]
 *     [--precision f32] [--workers 4] [--engine js]
 *
 * After each iteration it walks the tree once with both players' reach under
 * the current profile — the regret-matched strategy the next iteration plays
 * — kept as one bit per combination: a hand reaches a node when every action
 * on the way has non-zero strategy for it. A block (one decision node on one
 * board, its regrets and strategy sums) is "unreached" when either player
 * reaches it with no hand at all. Nothing that iteration reads or writes
 * there matters: the counterfactual values are exactly zero. That is what a
 * subtree "played by no hand" means, and it catches more than a single dead
 * action does, since an action can be alive for some hands and the next
 * action alive for others.
 *
 * Storage counts slots (one regret and one strategy sum each), so the shares
 * hold at any precision. Three ways to free it, finest first:
 *
 * - per block: any unreached block, which needs an allocator per block;
 * - per node: a decision node unreached on every board it is dealt on, as
 *   the issue states it; one allocation per node;
 * - stays unreached: per block, unreached at every census of the last W
 *   iterations, which is what a regret bound would have to promise before
 *   freeing paid off.
 *
 * Reach on a stored board that stands for several deals is the union over
 * them, and a packed orbit leader's is the union over its orbit, so the
 * census never calls a reached block unreached.
 */

import { createRun, defineSpot } from '../src/index.ts';
import type { Precision, SpotConfig } from '../src/index.ts';
import { COMBOS } from '../src/cards.ts';
import { NodeKind } from '../src/tree.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const target = { pot: 55, stack: 975, oop: OOP, ip: IP, betSizes: [[0.33, 0.75, 1.5]] };
// T₀ is the issue's "3 sizes, all-in-only raise, 2 aggressions" row (758
// decision nodes, 5.1 GiB at f32); T is the target itself.
const T0 = { ...target, raiseSizes: ['allin'], maxRaises: 2 };
const T = { ...target, raiseSizes: [[0.75]], maxRaises: 3, allowAllIn: true };
// A shallow T: the target's betting on the turn and river only, from a turn.
const SPOTS: Record<string, SpotConfig> = {
	T0: { board: 'As Kh 7d', ...T0 } as SpotConfig,
	'T0-mono': { board: 'Ks 9s 4s', ...T0 } as SpotConfig,
	T: { board: 'As Kh 7d', ...T } as SpotConfig,
	'T-mono': { board: 'Ks 9s 4s', ...T } as SpotConfig,
	small: { board: 'As Kh 7d', pot: 100, stack: 200, oop: OOP, ip: IP, betSizes: [[0.5]], maxRaises: 1 } as SpotConfig,
	'small-mono': { board: 'Ks 9s 4s', pot: 100, stack: 200, oop: OOP, ip: IP, betSizes: [[0.5]], maxRaises: 1 } as SpotConfig,
	'T-turn': { board: 'As Kh 7d 2c', ...T } as SpotConfig,
	'T-turn-mono': { board: 'Ks 9s 4s 2c', ...T } as SpotConfig,
};

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : fallback;
};
const names = opt('spots', 'T0').split(',');
const iterations = Number(opt('iters', '100'));
const precision = opt('precision', 'f32') as Precision;
const workers = Number(opt('workers', '1'));
const engine = opt('engine', '') === 'js' ? ('js' as const) : undefined;
const REPORT = new Set([1, 2, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 400, 500].filter((t) => t <= iterations));
const WINDOWS = [5, 10, 20, 50];

for (const name of names) {
	const spot = defineSpot({ ...SPOTS[name], maxBytes: 2 ** 40 });
	const started = performance.now();
	const run = createRun(spot, { workers, precision, engine });
	const ctx = run.solver.ctx;
	const { tree, runouts, layout, active } = ctx;
	const regret = ctx.regret;
	const maps = runouts.maps.combo;

	// Slots per block, and per node over all its boards.
	const blockSlots = new Float64Array(layout.blocks);
	const nodeSlots = new Float64Array(tree.nodeCount);
	const blockNode = new Int32Array(layout.blocks);
	for (const node of tree.decisionNodes) {
		const round = tree.round[node];
		for (let board = 0; board < runouts.counts[round]; board++) {
			const slot = (active.roundBase[round] + board) * 2 + tree.player[node];
			const b = layout.blockOffset[node] + board;
			blockSlots[b] = tree.numEdges[node] * active.count[slot];
			blockNode[b] = node;
			nodeSlots[node] += blockSlots[b];
		}
	}
	const totalSlots = layout.totalSlots;
	const slotsByRound = [0, 0, 0];
	const roundNames = runouts.width.slice(0, runouts.rounds).map((w) => ['flop', 'turn', 'river'][w - 3]).join('/');
	for (const node of tree.decisionNodes) slotsByRound[tree.round[node]] += nodeSlots[node];

	// Last iteration each block was reached at, 0 for never.
	const lastReached = new Int32Array(layout.blocks);
	// Per node, whether it was reached on any board this census.
	const nodeReached = new Uint8Array(tree.nodeCount);

	// Reach bits per combination, one pair of buffers per depth.
	const depthBuffers: Uint8Array[][] = [];
	const buffers = (depth: number): Uint8Array[] => {
		while (depthBuffers.length <= depth) depthBuffers.push([new Uint8Array(COMBOS), new Uint8Array(COMBOS)]);
		return depthBuffers[depth];
	};

	/** Does player `p` reach this board with any hand? Reads the list's members. */
	const anyReach = (reach: Uint8Array, slot: number): boolean => {
		const from = active.start[slot];
		const to = from + active.count[slot];
		for (let e = from; e < to; e++) {
			for (let m = active.memberStart[e]; m < active.memberStart[e + 1]; m++) {
				if (reach[active.memberCombo[m]]) return true;
			}
		}
		return false;
	};

	let iteration = 0;
	const walk = (node: number, board: number, reach: Uint8Array[], depth: number): void => {
		const kind = tree.kind[node];
		if (kind === NodeKind.TerminalFold || kind === NodeKind.TerminalShowdown) return;
		const round = tree.round[node];
		if (kind === NodeKind.Chance) {
			const child = tree.edgeChild[tree.firstEdge[node]];
			const next = round + 1;
			const starts = runouts.childStart[next];
			const out = buffers(depth + 1);
			for (let b = starts[board]; b < starts[board + 1]; b++) {
				for (let p = 0; p < 2; p++) {
					const into = out[p];
					into.fill(0);
					const from = reach[p];
					for (let m = runouts.orbitStart[next][b]; m < runouts.orbitStart[next][b + 1]; m++) {
						const map = maps[runouts.orbitMap[next][m]];
						for (let h = 0; h < COMBOS; h++) if (from[h]) into[map[h]] = 1;
					}
				}
				const s = (active.roundBase[next] + b) * 2;
				if (!anyReach(out[0], s) || !anyReach(out[1], s + 1)) continue;
				walk(child, b, out, depth + 1);
			}
			return;
		}
		const owner = tree.player[node];
		const actions = tree.numEdges[node];
		const slot = (active.roundBase[round] + board) * 2 + owner;
		lastReached[layout.blockOffset[node] + board] = iteration;
		nodeReached[node] = 1;
		const n = active.count[slot];
		const first = active.start[slot];
		const base = layout.offset[node] + actions * layout.rowStart[slot];
		const out = buffers(depth + 1);
		const mine = out[owner];
		const theirs = reach[1 - owner];
		for (let a = 0; a < actions; a++) {
			mine.fill(0);
			let any = false;
			for (let i = 0; i < n; i++) {
				const e = first + i;
				// Strategy for action a is zero exactly when its regret is not
				// positive while some other action's is.
				let positive = false;
				for (let k = 0; k < actions; k++) if (regret[base + k * n + i] > 0) positive = true;
				if (positive && !(regret[base + a * n + i] > 0)) continue;
				for (let m = active.memberStart[e]; m < active.memberStart[e + 1]; m++) {
					const combo = active.memberCombo[m];
					if (reach[owner][combo]) {
						mine[combo] = 1;
						any = true;
					}
				}
			}
			if (!any) continue;
			// The child reads `out`, which the next action reuses: copy the
			// opponent's bits in and recurse before moving on.
			out[1 - owner].set(theirs);
			walk(tree.edgeChild[tree.firstEdge[node] + a], board, out, depth + 1);
		}
	};

	const census = (): { block: number; node: number; stays: number[]; byRound: number[] } => {
		nodeReached.fill(0);
		const root = buffers(0);
		for (let p = 0; p < 2; p++) {
			root[p].fill(0);
			const index = ctx.players[p];
			for (let i = 0; i < index.count; i++) root[p][index.combos[i]] = 1;
		}
		walk(0, 0, root, 0);
		let block = 0;
		const byRound = [0, 0, 0];
		const stays = WINDOWS.map(() => 0);
		for (let b = 0; b < layout.blocks; b++) {
			const last = lastReached[b];
			if (last === iteration) continue;
			block += blockSlots[b];
			byRound[tree.round[blockNode[b]]] += blockSlots[b];
			// Unreached at this census and the W - 1 before it.
			for (let w = 0; w < WINDOWS.length; w++) if (iteration - last >= WINDOWS[w]) stays[w] += blockSlots[b];
		}
		let node = 0;
		for (const d of tree.decisionNodes) if (!nodeReached[d]) node += nodeSlots[d];
		return { block, node, stays, byRound };
	};

	const pct = (x: number, of = totalSlots): string => `${((100 * x) / of).toFixed(1)}%`;
	console.log(
		`\n${name}: ${spot.players[0].count} vs ${spot.players[1].count} combos, ${tree.decisionNodes.length} decision nodes, ` +
			`${(layout.bytes / 2 ** 30).toFixed(2)} GiB at ${precision}, ${run.workers ?? workers} worker(s); ` +
			`storage by round ${slotsByRound.map((s) => pct(s)).join(' / ')}`,
	);
	console.log(
		'  iter   unreached: per block   per node   stays ' +
			WINDOWS.map((w) => `${w}it`.padStart(6)).join('') +
			`   block share by round (${roundNames})`.padEnd(41) + '   exploit %   s/iter',
	);
	let stepMs = 0;
	for (iteration = 1; iteration <= iterations; iteration++) {
		// Census of the profile the coming iteration plays, as in #26.
		const result = census();
		const t0 = performance.now();
		run.step(1);
		stepMs += performance.now() - t0;
		if (!REPORT.has(iteration)) continue;
		const exploit = run.exploitabilityPercent();
		const rounds = result.byRound.slice(0, runouts.rounds).map((s, r) => pct(s, slotsByRound[r])).join(' / ');
		console.log(
			`${String(iteration).padStart(6)}${pct(result.block).padStart(24)}${pct(result.node).padStart(11)}      ` +
				result.stays.map((s) => pct(s).padStart(6)).join('') +
				`${rounds.padStart(41)}${exploit.toFixed(3).padStart(12)}${(stepMs / 1000 / iteration).toFixed(1).padStart(9)}`,
		);
	}
	console.log(`  total ${((performance.now() - started) / 1000).toFixed(0)} s`);
	run.close();
}
