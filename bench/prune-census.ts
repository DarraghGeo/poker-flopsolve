/**
 * Regret-based pruning census (issue #26, step 1).
 *
 * Purpose: before building any pruning, measure how much of a training
 * iteration's work sits below actions that no hand of the actor plays.
 *
 *   node --import tsx bench/prune-census.ts [--spots flop,monotone] [--iters 300]
 *
 * After each iteration it reads the regrets and, for each traverser, walks
 * the tree as a training traversal would, without the hand vectors: a
 * (node, board) visit costs about the hands it touches, so that is the work
 * counted. Below a decision node, an action whose regret-matched strategy is
 * zero for every hand of the actor on that board is "dead":
 *
 * - dead at an OPPONENT node: the traverser's counterfactual values there
 *   are exactly zero, since the opponent's reach into it is zero. The values
 *   could be skipped exactly — but the traverser's own nodes beneath would
 *   miss their DCFR discount and strategy-sum update that iteration.
 * - dead at a TRAVERSER node: the subtree's action values are needed for
 *   the regret update; skipping it is what regret-based pruning (Brown &
 *   Sandholm 2015) does, with a catch-up on revisit.
 *
 * A dead subtree inside another dead subtree counts once, at the top.
 */

import { createRun, defineSpot } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { NodeKind } from '../src/tree.ts';

const WIDE_OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const WIDE_IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const PB = 'AA-22,AKs-ATs,KQs-KTs,QJs-QTs,JTs,AKo-ATo,KQo-KTo,QJo-QTo,JTo';

const compare = (board: string, oop = WIDE_OOP, ip = WIDE_IP): SpotConfig =>
	({ board, pot: 100, stack: 200, oop, ip, betSizes: [[0.5]], maxRaises: 1 }) as SpotConfig;

const SPOTS: Record<string, SpotConfig> = {
	flop: compare('As Kh 7d'),
	monotone: compare('Ks 9s 4s'),
	wideflop: { board: 'AsKh7d', pot: 60, stack: 120, oop: WIDE_OOP, ip: WIDE_IP, betSizes: [[0.66]], maxRaises: 1 },
	'flop-pb': compare('As Kh 7d', PB, PB),
	'monotone-pb': compare('Ks 9s 4s', PB, PB),
	turn: { board: 'AsKh7d2c', pot: 60, stack: 120, oop: WIDE_OOP, ip: WIDE_IP, betSizes: [[0.33, 0.75]], maxRaises: 2 },
};

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : fallback;
};
const names = opt('spots', 'flop,monotone,wideflop,flop-pb,monotone-pb').split(',');
const iterations = Number(opt('iters', '300'));
const REPORT = [1, 2, 5, 10, 20, 50, 100, 150, 200, 300, 500, 1000].filter((t) => t <= iterations);

for (const name of names) {
	const spot = defineSpot(SPOTS[name]);
	const run = createRun(spot, { workers: 1 });
	const ctx = run.solver.ctx;
	const { tree, runouts, layout, active } = ctx;
	const regret = ctx.regret;

	/** Is action `a` at (node, board) played by no hand of its owner? */
	const deadMask = (node: number, board: number): number => {
		const owner = tree.player[node];
		const actions = tree.numEdges[node];
		const slot = (active.roundBase[tree.round[node]] + board) * 2 + owner;
		const n = active.count[slot];
		if (n === 0) return 0;
		const base = layout.offset[node] + actions * layout.rowStart[slot];
		// An action is dead when every hand has it at zero strategy: its
		// regret non-positive while some other action's is positive.
		let mask = (1 << actions) - 1;
		for (let i = 0; i < n && mask !== 0; i++) {
			let anyPositive = false;
			for (let a = 0; a < actions; a++) if (regret[base + a * n + i] > 0) anyPositive = true;
			if (!anyPositive) return 0; // uniform for this hand: every action played
			for (let a = 0; a < actions; a++) if (regret[base + a * n + i] > 0) mask &= ~(1 << a);
		}
		return mask;
	};

	let blocks = 0;
	let deadBlocks = 0;
	const walk = (traverser: number, node: number, board: number, out: Float64Array): number => {
		const round = tree.round[node];
		const listBase = (active.roundBase[round] + board) * 2;
		const kind = tree.kind[node];
		const hands = active.count[listBase] + active.count[listBase + 1];
		if (kind === NodeKind.TerminalFold || kind === NodeKind.TerminalShowdown) return hands;
		if (kind === NodeKind.Chance) {
			const child = tree.edgeChild[tree.firstEdge[node]];
			const starts = runouts.childStart[round + 1];
			let total = 0;
			for (let b = starts[board]; b < starts[board + 1]; b++) total += walk(traverser, child, b, out);
			return total;
		}
		const actions = tree.numEdges[node];
		const owner = tree.player[node];
		let total = actions * hands;
		const dead = deadMask(node, board);
		if (traverser === 0) {
			blocks++;
			if (dead) deadBlocks++;
		}
		for (let a = 0; a < actions; a++) {
			const child = tree.edgeChild[tree.firstEdge[node] + a];
			if (dead & (1 << a)) {
				const inner = new Float64Array(2);
				const work = walk(traverser, child, board, inner);
				out[owner === traverser ? 1 : 0] += work;
				total += work;
			} else {
				total += walk(traverser, child, board, out);
			}
		}
		return total;
	};

	console.log(`\n${name}: ${spot.players[0].count} vs ${spot.players[1].count} combos`);
	console.log('  iter   dead blocks   dead work: opp node (exact)   own node (RBP)   total   cumulative   exploit %');
	// Every iteration costs the same unpruned, so the share of all work up to
	// iteration t that pruning could have skipped is the mean of the shares.
	let cumulative = 0;
	const crossed = new Map<number, { t: number; share: number }>();
	for (let t = 1; t <= iterations; t++) {
		// Census of the regrets the coming iteration will play from.
		blocks = 0;
		deadBlocks = 0;
		let total = 0;
		const dead = new Float64Array(2);
		for (const traverser of [0, 1]) total += walk(traverser, 0, 0, dead);
		cumulative += (dead[0] + dead[1]) / total;
		run.step(1);
		const check = REPORT.includes(t) || (t % 5 === 0 && crossed.size < 2);
		if (!check) continue;
		const exploit = run.exploitabilityPercent();
		for (const target of [0.5, 0.3]) {
			if (!crossed.has(target) && exploit <= target) crossed.set(target, { t, share: cumulative / t });
		}
		if (!REPORT.includes(t)) continue;
		const pct = (x: number): string => `${((100 * x) / total).toFixed(1)}%`;
		console.log(
			`${String(t).padStart(6)}${`${((100 * deadBlocks) / blocks).toFixed(1)}%`.padStart(14)}` +
				`${pct(dead[0]).padStart(30)}${pct(dead[1]).padStart(17)}${pct(dead[0] + dead[1]).padStart(8)}` +
				`${`${((100 * cumulative) / t).toFixed(1)}%`.padStart(13)}${exploit.toFixed(3).padStart(12)}`,
		);
	}
	for (const [target, { t, share }] of crossed) {
		console.log(`  ${target}% of pot by iteration ${t} (checked every 5): ${(100 * share).toFixed(1)}% of the work to get there was below dead actions`);
	}
	run.close();
}
