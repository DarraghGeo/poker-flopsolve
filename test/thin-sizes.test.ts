/**
 * `thinSizes`: every size at the root, one elsewhere, and the big sizes when
 * the last round opens after an earlier one saw a bet (issue #51).
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, solve } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { ActionKind, NodeKind } from '../src/tree.ts';
import type { Tree } from '../src/tree.ts';

const base: SpotConfig = {
	board: 'As Kh 7d 2c', pot: 60, stack: 200,
	oop: 'AA,KK,77,AKs,AQs,KQs,65s', ip: 'QQ,JJ,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.33, 0.75, 1.5]], raiseSizes: [[0.75]], maxRaises: 2, allowAllIn: true,
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

/** The bets, raises and shoves offered at the decision reached by `line`. */
function sizes(p: { tree: Tree; path: string[] }, line: string): string[] {
	const node = p.path.findIndex((path, n) => path === line && p.tree.kind[n] === NodeKind.Decision);
	expect(node, line).toBeGreaterThanOrEqual(0);
	const out: string[] = [];
	for (let e = 0; e < p.tree.numEdges[node]; e++) {
		const edge = p.tree.firstEdge[node] + e;
		if (p.tree.edgeAction[edge] >= ActionKind.Bet) out.push(p.path[p.tree.edgeChild[edge]]);
	}
	return out;
}

describe('thinSizes', () => {
	it('leaves the tree untouched when unset or false', () => {
		const plain = defineSpot(base).tree;
		expect(defineSpot({ ...base, thinSizes: false }).tree).toEqual(plain);
	});

	it('keeps every size at the root and the one nearest 0.75 of pot elsewhere', () => {
		const full = paths(base);
		const thin = paths({ ...base, thinSizes: true });
		expect(sizes(thin, '(root)')).toEqual(sizes(full, '(root)'));
		expect(sizes(thin, '(root)')).toEqual(['bet 19.8', 'bet 45', 'bet 90', 'allin 200']);
		// In position after a check, and the turn opening without a bet.
		expect(sizes(full, 'check')).toHaveLength(4);
		expect(sizes(thin, 'check')).toEqual(['check bet 45']);
		// Facing a bet: the 0.75 raise, not the shove.
		expect(sizes(full, 'bet 45')).toEqual(['bet 45 raise 157.5', 'bet 45 allin 200']);
		expect(sizes(thin, 'bet 45')).toEqual(['bet 45 raise 157.5']);
		expect(thin.tree.nodeCount).toBeLessThan(full.tree.nodeCount);
		expect(defineSpot({ ...base, thinSizes: true }).estimate.bytes).toBeLessThan(defineSpot(base).estimate.bytes);
	});

	it('keeps the big sizes on the last round only after an earlier one saw a bet', () => {
		const thin = paths({ ...base, thinSizes: true });
		// Checked through: one size.
		expect(sizes(thin, 'check check /')).toEqual(['check check / bet 45']);
		// After a bet and a call: 0.75 of pot and the shove, not 0.33.
		expect(sizes(paths(base), 'bet 45 call /')).toEqual(['bet 45 call / bet 94.5', 'bet 45 call / bet 157.5', 'bet 45 call / allin 200']);
		expect(sizes(thin, 'bet 45 call /')).toEqual(['bet 45 call / bet 157.5', 'bet 45 call / allin 200']);
		// The player in position after a check gets the same.
		expect(sizes(thin, 'bet 45 call / check')).toEqual(['bet 45 call / check bet 157.5', 'bet 45 call / check allin 200']);
	});

	it('keeps a shove where the size nearest 0.75 of pot is one', () => {
		const short: SpotConfig = { ...base, stack: 70, betSizes: [[0.33, 1.5]], allowAllIn: false };
		const thin = paths({ ...short, thinSizes: true });
		// 1.5 of the pot after a call is beyond the stack, so it is the shove.
		expect(sizes(thin, 'check')).toEqual(['check allin 70']);
	});

	it('goes with removeActions: a kept line can be cut, a thinned one is not there', () => {
		const config: SpotConfig = { ...base, thinSizes: true };
		const cut = paths({ ...config, removeActions: ['bet 45 call / allin 200'] });
		expect(sizes(cut, 'bet 45 call /')).toEqual(['bet 45 call / bet 157.5']);
		expect(() => defineSpot({ ...config, removeActions: ['check bet 19.8'] })).toThrow(/check bet 19\.8/);
	});

	it('solves alike on one thread and on two', () => {
		const config: SpotConfig = { ...base, thinSizes: true };
		const one = solve(defineSpot(config), { iterations: 30, workers: 1, precision: 'f64' });
		const two = solve(defineSpot(config), { iterations: 30, workers: 2, precision: 'f64' });
		expect(Number.isFinite(one.exploitability())).toBe(true);
		expect(two.ev(0)).toBeCloseTo(one.ev(0), 9);
		expect(two.exploitability()).toBeCloseTo(one.exploitability(), 9);
	});

	it('gives a subgame the full sizes back unless its betting thins them again', () => {
		const config: SpotConfig = { ...base, thinSizes: true, removeActions: ['bet 45 call / allin 200'] };
		const spot = defineSpot(config);
		const run = createRun(spot);
		run.step(5);
		const solution = run.snapshot();
		const node = Array.from({ length: spot.tree.nodeCount }, (_, n) => n).find(
			(n) => solution.path(n) === 'bet 45 call /' && spot.tree.kind[n] === NodeKind.Decision,
		)!;
		const sub = solution.subgameAt(node, 0);
		expect(sub.thinSizes).toBeUndefined();
		// The cut below the node still fits the full tree, so it carries over.
		expect(sub.removeActions).toEqual(['allin 155']);
		expect(() => defineSpot(sub)).not.toThrow();
		const thinned = solution.subgameAt(node, 0, { thinSizes: true });
		expect(thinned.thinSizes).toBe(true);
		expect(thinned.removeActions).toBeUndefined();
		run.close();
	});
});
