import { describe, expect, it } from 'vitest';
import { ActionKind, createRun, defineSpot, NodeKind } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';

/**
 * Betting set per round.
 *
 * Raise counts, raise sizes and the shove can each be given once, as before,
 * or one per betting round, the way bet sizes already could.
 */
describe('per-round betting', () => {
	const base = {
		board: 'Qs Jh 4d 2c',
		pot: 40,
		stack: 100,
		oop: 'JJ, TT, AQs, KQs, QTs, J9s, 87s, AJo',
		ip: 'AA, KK, AJs, QJs, JTs, T9s, 65s, KQo',
		betSizes: [[0.5]],
	} satisfies SpotConfig;

	/** Action kinds at the node a readable path reaches, or at the root. */
	const actionsAt = (config: SpotConfig, line: string): number[] => {
		const spot = defineSpot(config);
		const sol = createRun(spot).snapshot();
		const { tree } = spot;
		for (let node = 0; node < tree.nodeCount; node++) {
			if (tree.kind[node] !== NodeKind.Decision || sol.path(node) !== line) continue;
			return Array.from(tree.edgeAction.subarray(tree.firstEdge[node], tree.firstEdge[node] + tree.numEdges[node]));
		}
		throw new Error(`no decision at "${line}"`);
	};

	it('offers the shove only on the rounds that allow it', () => {
		const config = { ...base, allowAllIn: [false, true] };
		expect(actionsAt(config, '(root)')).toEqual([ActionKind.Check, ActionKind.Bet]);
		expect(actionsAt(config, 'check check /')).toEqual([ActionKind.Check, ActionKind.Bet, ActionKind.AllIn]);
	});

	it('allows raises only on the rounds that allow them', () => {
		const config = { ...base, maxRaises: [1, 2] };
		expect(actionsAt(config, 'check bet 20')).toEqual([ActionKind.Fold, ActionKind.Call]);
		expect(actionsAt(config, 'check check / check bet 20')).toEqual([ActionKind.Fold, ActionKind.Call, ActionKind.Raise]);
	});

	it('takes raise sizes per round', () => {
		const config = { ...base, maxRaises: 2, raiseSizes: [[{ times: 3 }], [{ times: 2 }, { times: 4 }]] };
		expect(actionsAt(config, 'check bet 20').filter((a) => a === ActionKind.Raise)).toHaveLength(1);
		expect(actionsAt(config, 'check check / check bet 20').filter((a) => a === ActionKind.Raise)).toHaveLength(2);
	});

	it('jams only on the river with a shove as the river bet size', () => {
		const config = { ...base, betSizes: [[0.5], ['allin' as const]] };
		expect(actionsAt(config, 'check check /')).toEqual([ActionKind.Check, ActionKind.AllIn]);
	});

	it('builds the same tree from one value as from that value per round', () => {
		const once = defineSpot({ ...base, maxRaises: 2, allowAllIn: true, raiseSizes: [{ times: 3 }] });
		const each = defineSpot({ ...base, maxRaises: [2, 2], allowAllIn: [true, true], raiseSizes: [[{ times: 3 }], [{ times: 3 }]] });
		expect(each.tree.nodeCount).toBe(once.tree.nodeCount);
		expect(Array.from(each.tree.edgeTarget)).toEqual(Array.from(once.tree.edgeTarget));
	});

	it('refuses a list with the wrong number of rounds', () => {
		expect(() => defineSpot({ ...base, maxRaises: [1, 2, 3] })).toThrow(/maxRaises has 3 entries/);
		expect(() => defineSpot({ ...base, allowAllIn: [true, false, true] })).toThrow(/allowAllIn has 3 entries/);
	});

	it('carries the later rounds into a subgame', () => {
		const config = { ...base, maxRaises: [1, 2], allowAllIn: [false, true], raiseSizes: [[{ times: 3 }], [{ times: 2 }]] };
		const spot = defineSpot(config);
		const run = createRun(spot);
		run.step(50);
		const sol = run.snapshot();
		const { tree } = spot;
		let river = -1;
		for (let node = 0; node < tree.nodeCount && river < 0; node++) {
			if (tree.kind[node] === NodeKind.Decision && sol.path(node) === 'check check /') river = node;
		}
		const sub = sol.subgameAt(river, 0);
		expect(sub.maxRaises).toEqual([2]);
		expect(sub.allowAllIn).toEqual([true]);
		expect(sub.raiseSizes).toEqual([[{ times: 2 }]]);
		expect(() => defineSpot(sub)).not.toThrow();
	});
});
