import { describe, expect, it } from 'vitest';
import { COMBOS, createRun, defineSpot, NodeKind, solve } from '../src/index.ts';
import type { Solution } from '../src/index.ts';
import { Mode } from '../src/cfr.ts';
import { resolveSubgame } from '../src/resolve.ts';
import type { Gadget } from '../src/resolve.ts';
import { matchNodes, warmStart } from '../src/warm.ts';

/**
 * Safe and nested subgame re-solving (issue #47): a blueprint with one bet
 * size on a turn, its river subgames re-solved with each gadget.
 */
describe('resolveSubgame', () => {
	const config = {
		board: 'Qs Jh 4d 2c',
		pot: 40,
		stack: 60,
		oop: 'JJ, TT, AQs, KQs, QTs, J9s, 87s, AJo',
		ip: 'AA, KK, AJs, QJs, JTs, T9s, 65s, KQo',
		betSizes: [[0.75]],
		maxRaises: 1,
	};
	const run = createRun(defineSpot(config), { workers: 1 });
	run.step(1500);
	const blueprint = run.snapshot();
	const { tree } = blueprint.spot;
	const riverAfter = (sol: Solution, path: string): number => {
		const t = sol.spot.tree;
		for (let node = 0; node < t.nodeCount; node++) {
			if (t.kind[node] !== NodeKind.Chance) continue;
			const child = t.edgeChild[t.firstEdge[node]];
			if (sol.path(child) === path) return child;
		}
		throw new Error(`no node after ${path}`);
	};
	const checked = riverAfter(blueprint, 'check check /');
	const rich = { betSizes: [[0.33, 0.75, 1.5]], maxRaises: 2, allowAllIn: true };
	const gadgets: Gadget[] = ['resolve', 'maxmargin', 'reach-maxmargin'];

	/** Largest margin, in chips, by which an opponent hand beats its guaranteed value. */
	const worstExcess = (alternative: Float64Array, entered: Float64Array): number => {
		let worst = -Infinity;
		for (let combo = 0; combo < COMBOS; combo++) {
			if (Number.isNaN(entered[combo])) continue;
			worst = Math.max(worst, entered[combo] - alternative[combo]);
		}
		return worst;
	};

	it("copies a solve's subtree into a subgame exactly", () => {
		for (const board of [0, 20]) {
			const sub = createRun(defineSpot(blueprint.subgameAt(checked, board)), { analysisOnly: true });
			const report = warmStart(sub.solver.ctx, run.solver.ctx, true, undefined, checked);
			expect(report.matchedNodes).toBe(report.decisionNodes);
			const copy = sub.snapshot();
			const subTree = copy.spot.tree;
			const match = matchNodes(subTree, tree, checked);
			for (const node of subTree.decisionNodes) {
				const original = match[node];
				expect(original).toBeGreaterThanOrEqual(0);
				const a = copy.strategyAt(node, 0);
				const b = blueprint.strategyAt(original, board);
				const at = new Map(Array.from(b.combos, (combo, i) => [combo, i]));
				for (let i = 0; i < a.combos.length; i++) {
					const j = at.get(a.combos[i])!;
					for (let k = 0; k < a.actions.length; k++) {
						expect(a.probs[i * a.actions.length + k]).toBeCloseTo(b.probs[j * b.actions.length + k], 6);
					}
				}
			}
		}
	});

	it('gives best-response values at a node that bound the average ones', () => {
		const w = blueprint.spot.players;
		const live = Uint16Array.from({ length: COMBOS }, (_, i) => i).filter((c) => w[0].weights[c] > 0 || w[1].weights[c] > 0);
		const avg = run.solver.valuesAt(0, 0, 1, w[1].weights, w[0].weights, live, live.length);
		const br = run.solver.valuesAt(0, 0, 1, w[1].weights, w[0].weights, live, live.length, Mode.BestResponse);
		let sumAvg = 0;
		let sumBr = 0;
		for (const combo of live) {
			expect(br[combo]).toBeGreaterThanOrEqual(avg[combo] - 1e-9);
			sumAvg += w[1].weights[combo] * avg[combo];
			sumBr += w[1].weights[combo] * br[combo];
		}
		// The best response gains what exploitability says it does, near nothing here.
		expect(sumBr - sumAvg).toBeGreaterThanOrEqual(0);
		expect((sumBr - sumAvg) / sumAvg).toBeLessThan(1e-3);
	});

	it("is a plain subgame solve when 'unsafe', bit for bit", () => {
		const resolved = resolveSubgame(blueprint, checked, 7, { player: 0, gadget: 'unsafe', betting: rich, iterations: 120 });
		const plain = solve(defineSpot(blueprint.subgameAt(checked, 7, rich)), { iterations: 120, workers: 1 });
		expect(resolved.solution.ev(0)).toBe(plain.ev(0));
		expect(Array.from(resolved.solution.strategyAt(0, 0).probs)).toEqual(Array.from(plain.strategyAt(0, 0).probs));
	});

	it.each(gadgets)("with the blueprint's own betting, %s gives no opponent hand more than the blueprint did", (gadget) => {
		for (const player of [0, 1] as const) {
			const resolved = resolveSubgame(blueprint, checked, 7, { player, gadget, iterations: 600 });
			// Chips, at a pot of 40: the blueprint is near equilibrium, so its
			// own strategy meets every guarantee and the re-solve finds one that does.
			expect(worstExcess(resolved.alternative, resolved.entered)).toBeLessThan(0.05);
			// The opponent's range comes back as the blueprint brings it.
			const reach = blueprint.reachAt(checked, 7, (1 - player) as 0 | 1);
			const weights = resolved.solution.spot.players[1 - player].weights;
			for (let combo = 0; combo < COMBOS; combo++) if (weights[combo] > 0) expect(weights[combo]).toBe(reach[combo]);
		}
	});

	it('maxmargin keeps the worst opponent hand closer to its blueprint value than an unsafe re-solve', () => {
		// A blueprint far from equilibrium, so its ranges at the node are off
		// and an unsafe re-solve over-fits them.
		const early = createRun(defineSpot(config), { workers: 1 });
		early.step(15);
		const rough = early.snapshot();
		const node = riverAfter(rough, 'check check /');
		for (const player of [0, 1] as const) {
			const unsafe = resolveSubgame(rough, node, 3, { player, gadget: 'unsafe', iterations: 400 });
			const margin = resolveSubgame(rough, node, 3, { player, gadget: 'maxmargin', iterations: 400 });
			expect(worstExcess(margin.alternative, margin.entered)).toBeLessThanOrEqual(worstExcess(unsafe.alternative, unsafe.entered) + 1e-9);
		}
	});

	it('reach-maxmargin raises each guarantee by a non-negative gift', () => {
		const plain = resolveSubgame(blueprint, checked, 7, { player: 0, gadget: 'maxmargin', iterations: 10 });
		const reach = resolveSubgame(blueprint, checked, 7, { player: 0, gadget: 'reach-maxmargin', iterations: 10 });
		expect(plain.gifts).toBeNull();
		let positive = 0;
		for (let combo = 0; combo < COMBOS; combo++) {
			if (Number.isNaN(reach.alternative[combo])) continue;
			const gift = reach.gifts![combo];
			expect(gift).toBeGreaterThanOrEqual(0);
			expect(reach.alternative[combo]).toBeCloseTo(plain.alternative[combo] + gift, 9);
			if (gift > 1e-6) positive++;
		}
		// IP checked behind on the turn with hands that would rather have bet.
		expect(positive).toBeGreaterThan(0);
	});

	it('nests: a river re-solved from a re-solved turn', () => {
		const flop = { ...config, board: 'Qs Jh 4d', stack: 100 };
		const outer = createRun(defineSpot(flop), { workers: 1 });
		outer.step(150);
		const sol = outer.snapshot();
		const t = sol.spot.tree;
		let turnNode = -1;
		for (let node = 0; node < t.nodeCount && turnNode < 0; node++) {
			if (t.kind[node] === NodeKind.Chance && t.round[node] === 0) turnNode = t.edgeChild[t.firstEdge[node]];
		}
		const turn = resolveSubgame(sol, turnNode, 4, { player: 0, gadget: 'resolve', betting: rich, iterations: 60 });
		expect(turn.solution.spot.board).toHaveLength(4);
		const river = riverAfter(turn.solution, 'check check /');
		const nested = resolveSubgame(turn.solution, river, 2, { player: 0, gadget: 'maxmargin', iterations: 60 });
		expect(nested.solution.spot.board).toHaveLength(5);
		expect(Number.isFinite(nested.solution.ev(0))).toBe(true);
	});

	it('refuses a node that does not open a betting round', () => {
		const midRound = tree.edgeChild[tree.firstEdge[checked]];
		expect(() => resolveSubgame(blueprint, midRound, 0, { player: 0 })).toThrow(/does not open a betting round/);
	});
});
