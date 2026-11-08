/**
 * `removeActions`: cutting single bets, raises and shoves out of the tree by
 * the path of the node each leads to.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, solve } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { ActionKind, NodeKind } from '../src/tree.ts';
import type { Tree } from '../src/tree.ts';

const base: SpotConfig = {
	board: 'As Kh 7d 2c', pot: 60, stack: 200,
	oop: 'AA,KK,77,AKs,AQs,KQs,65s', ip: 'QQ,JJ,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.33, 0.75]], raiseSizes: [[1]], maxRaises: 2, allowAllIn: true,
};

/** Every node's readable path, as `Solution.path` writes it. */
function paths(config: SpotConfig): { tree: Tree; path: string[] } {
	const spot = defineSpot(config);
	const run = createRun(spot, { analysisOnly: true });
	const solution = run.snapshot();
	const path = Array.from({ length: spot.tree.nodeCount }, (_, node) => solution.path(node));
	run.close();
	return { tree: spot.tree, path };
}

/** Nodes in the subtree below `node`, itself included. */
function subtree(tree: Tree, node: number): number {
	let count = 1;
	for (let e = 0; e < tree.numEdges[node]; e++) count += subtree(tree, tree.edgeChild[tree.firstEdge[node] + e]);
	return count;
}

describe('removeActions', () => {
	it('leaves the tree untouched when unset or empty', () => {
		const plain = defineSpot(base).tree;
		const empty = defineSpot({ ...base, removeActions: [] }).tree;
		expect(empty).toEqual(plain);
	});

	it('cuts one bet and everything below it, nothing else', () => {
		const full = paths(base);
		const target = full.path.indexOf('bet 19.8');
		expect(target).toBeGreaterThan(0);
		const cut = paths({ ...base, removeActions: ['bet 19.8'] });
		expect(cut.tree.nodeCount).toBe(full.tree.nodeCount - subtree(full.tree, target));
		expect(cut.path).not.toContain('bet 19.8');
		// The rest of the root is unchanged, and the cut lines are gone.
		const rootLabels = (p: { tree: Tree; path: string[] }): string[] =>
			Array.from({ length: p.tree.numEdges[0] }, (_, e) => p.path[p.tree.edgeChild[p.tree.firstEdge[0] + e]]);
		expect(rootLabels(cut)).toEqual(rootLabels(full).filter((label) => label !== 'bet 19.8'));
		expect(cut.path.filter((p) => p.startsWith('bet 19.8 '))).toEqual([]);
	});

	it('cuts a line deep in the tree without touching the same size elsewhere', () => {
		const full = paths(base);
		const deep = 'check check / bet 19.8';
		expect(full.path).toContain(deep);
		const cut = paths({ ...base, removeActions: [deep] });
		expect(cut.path).not.toContain(deep);
		expect(cut.path).toContain('bet 19.8');
		expect(cut.path.some((p) => p.startsWith('check bet 19.8 call / bet '))).toBe(true);
	});

	it('removes raises and shoves, as many as are listed', () => {
		const full = paths(base);
		const raise = full.path.find((p) => p.startsWith('bet 19.8 raise'))!;
		const shove = full.path.find((p) => p.startsWith('check allin'))!;
		expect(raise).toBeDefined();
		expect(shove).toBeDefined();
		const cut = paths({ ...base, removeActions: [raise, shove] });
		expect(cut.path).not.toContain(raise);
		expect(cut.path).not.toContain(shove);
		const node = cut.path.indexOf('bet 19.8');
		const kinds = Array.from({ length: cut.tree.numEdges[node] }, (_, e) => cut.tree.edgeAction[cut.tree.firstEdge[node] + e]);
		expect(kinds).not.toContain(ActionKind.Raise);
		expect(kinds).toContain(ActionKind.Call);
	});

	it('refuses a path that names no bet, raise or shove', () => {
		expect(() => defineSpot({ ...base, removeActions: ['bet 20'] })).toThrow(/bet 20/);
		expect(() => defineSpot({ ...base, removeActions: ['check'] })).toThrow(/check/);
		expect(() => defineSpot({ ...base, removeActions: ['bet 19.8 fold'] })).toThrow(/fold/);
	});

	it('solves the cut tree, alike on one thread and on two', () => {
		const config: SpotConfig = { ...base, removeActions: ['bet 19.8', 'check check / bet 19.8'] };
		const one = solve(defineSpot(config), { iterations: 30, workers: 1, precision: 'f64' });
		const two = solve(defineSpot(config), { iterations: 30, workers: 2, precision: 'f64' });
		expect(Number.isFinite(one.exploitability())).toBe(true);
		expect(two.ev(0)).toBeCloseTo(one.ev(0), 9);
		expect(two.exploitability()).toBeCloseTo(one.exploitability(), 9);
	});

	it('carries the cuts below a subgame into it, re-rooted', () => {
		const config: SpotConfig = { ...base, removeActions: ['bet 19.8', 'check check / bet 19.8'] };
		const spot = defineSpot(config);
		const run = createRun(spot);
		run.step(5);
		const solution = run.snapshot();
		// The river opens after check, check on the turn.
		let node = -1;
		for (let n = 0; n < spot.tree.nodeCount; n++) {
			if (solution.path(n) === 'check check /' && spot.tree.kind[n] === NodeKind.Decision) node = n;
		}
		expect(node).toBeGreaterThan(0);
		const sub = solution.subgameAt(node, 0);
		expect(sub.removeActions).toEqual(['bet 19.8']);
		const rooted = solution.subgameAt(0, 0);
		expect(rooted.removeActions).toEqual(config.removeActions);
		expect(() => defineSpot(sub)).not.toThrow();
		// New betting for the subgame leaves the old tree's cuts behind.
		expect(solution.subgameAt(node, 0, { betSizes: [[0.5]] }).removeActions).toBeUndefined();
		run.close();
	});
});
