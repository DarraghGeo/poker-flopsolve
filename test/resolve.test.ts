import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMBO_CARDS, COMBOS, createRun, defineSpot, NodeKind, parseCards, solve } from '../src/index.ts';
import type { Solution, SolveRun } from '../src/index.ts';
import type { Tree } from '../src/tree.ts';
import { bestResponseAt, openMass, resolveSubgame } from '../src/resolve.ts';
import { copySubtree, matchSubtree } from '../src/subtree.ts';

/**
 * Nested subgame re-solving (issue #47): a blueprint with one bet size on a
 * turn, its river subgames re-solved.
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
	let run: SolveRun;
	let blueprint: Solution;
	let tree: Tree;
	let checked: number;
	const riverAfter = (sol: Solution, path: string): number => {
		const t = sol.spot.tree;
		for (let node = 0; node < t.nodeCount; node++) {
			if (t.kind[node] !== NodeKind.Chance) continue;
			const child = t.edgeChild[t.firstEdge[node]];
			if (sol.path(child) === path) return child;
		}
		throw new Error(`no node after ${path}`);
	};
	// Solved once for the file, when its tests run rather than when they are collected.
	beforeAll(() => {
		run = createRun(defineSpot(config), { workers: 1 });
		run.step(1500);
		blueprint = run.snapshot();
		tree = blueprint.spot.tree;
		checked = riverAfter(blueprint, 'check check /');
	});
	afterAll(() => run.close());
	const rich = { betSizes: [[0.33, 0.75, 1.5]], maxRaises: 2, allowAllIn: true };

	/** Largest margin, in chips, by which an opponent hand beats its value against the blueprint. */
	const worstExcess = (alternative: Float64Array | null, entered: Float64Array | null): number => {
		if (!alternative || !entered) throw new Error('not measured');
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
			const report = copySubtree(sub.solver.ctx, run.solver.ctx, true, checked);
			expect(report.matchedNodes).toBe(report.decisionNodes);
			const copy = sub.snapshot();
			const subTree = copy.spot.tree;
			const match = matchSubtree(subTree, tree, checked);
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

	it('matches bet sizes after earlier betting by what is put in this round', () => {
		// Deep enough that a river bet after a turn bet and call is not all-in.
		const deep = createRun(defineSpot({ ...config, stack: 400 }), { workers: 1 });
		deep.step(20);
		const sol = deep.snapshot();
		const start = riverAfter(sol, 'bet 30 call /');
		const sub = createRun(defineSpot(sol.subgameAt(start, 5)), { analysisOnly: true });
		const report = copySubtree(sub.solver.ctx, deep.solver.ctx, true, start);
		expect(report.matchedNodes).toBe(report.decisionNodes);
		const copy = sub.snapshot();
		const match = matchSubtree(copy.spot.tree, sol.spot.tree, start);
		for (const node of copy.spot.tree.decisionNodes) {
			const a = copy.strategyAt(node, 0);
			const b = sol.strategyAt(match[node], 5);
			// Labels differ (the parent's count the turn bet too); the play does not.
			expect(a.actions.length).toBe(b.actions.length);
			const at = new Map(Array.from(b.combos, (combo, i) => [combo, i]));
			for (let i = 0; i < a.combos.length; i++) {
				const j = at.get(a.combos[i])!;
				for (let k = 0; k < a.actions.length; k++) {
					expect(a.probs[i * a.actions.length + k]).toBeCloseTo(b.probs[j * b.actions.length + k], 6);
				}
			}
		}
	});

	it('gives best-response values at a node that bound the average ones', () => {
		const w = blueprint.spot.players;
		const live = Uint16Array.from({ length: COMBOS }, (_, i) => i).filter((c) => w[0].weights[c] > 0 || w[1].weights[c] > 0);
		const avg = run.solver.valuesAt(0, 0, 1, w[1].weights, w[0].weights, live, live.length);
		const br = bestResponseAt(run.solver.ctx, 0, 0, 1, w[1].weights, w[0].weights);
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

	it('is a plain subgame solve, bit for bit', () => {
		const resolved = resolveSubgame(blueprint, checked, 7, { player: 0, betting: rich, iterations: 120 });
		const plain = solve(defineSpot(blueprint.subgameAt(checked, 7, rich)), { iterations: 120, workers: 1 });
		expect(resolved.solution.ev(0)).toBe(plain.ev(0));
		// Nothing is measured that nothing uses, unless asked.
		expect(resolved.alternative).toBeNull();
		expect(resolved.entered).toBeNull();
		const measured = resolveSubgame(blueprint, checked, 7, { player: 0, betting: rich, iterations: 120, measure: true });
		expect(measured.solution.ev(0)).toBe(plain.ev(0));
		expect(measured.entered).not.toBeNull();
		expect(Array.from(resolved.solution.strategyAt(0, 0).probs)).toEqual(Array.from(plain.strategyAt(0, 0).probs));
	});

	it("with the blueprint's own betting, gives no opponent hand much more than the blueprint did", () => {
		for (const player of [0, 1] as const) {
			const resolved = resolveSubgame(blueprint, checked, 7, { player, iterations: 600, measure: true });
			// Chips, at a pot of 40: the blueprint is near equilibrium, and so
			// is a re-solve of the same subgame, to a few hundredths of a chip.
			expect(worstExcess(resolved.alternative, resolved.entered)).toBeLessThan(0.1);
			// The opponent's range comes back as the blueprint brings it.
			const reach = blueprint.reachAt(checked, 7, (1 - player) as 0 | 1);
			const weights = resolved.solution.spot.players[1 - player].weights;
			for (let combo = 0; combo < COMBOS; combo++) if (weights[combo] > 0) expect(weights[combo]).toBe(reach[combo]);
		}
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
		const turn = resolveSubgame(sol, turnNode, 4, { player: 0, betting: rich, iterations: 60 });
		expect(turn.solution.spot.board).toHaveLength(4);
		const river = riverAfter(turn.solution, 'check check /');
		const nested = resolveSubgame(turn.solution, river, 2, { player: 0, iterations: 60 });
		expect(nested.solution.spot.board).toHaveLength(5);
		expect(Number.isFinite(nested.solution.ev(0))).toBe(true);
	});

	it('gives a hand that faces no opponent hand exactly zero open mass', () => {
		// Every opponent hand holds the As or the Kd, so AsKd faces none of
		// them; a rounding residue would pass "> 0" checks and be divided by.
		const range = new Float64Array(COMBOS);
		let seed = 7;
		const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		const [As, Kd] = parseCards('As Kd');
		for (let combo = 0; combo < COMBOS; combo++) {
			const a = COMBO_CARDS[combo * 2];
			const b = COMBO_CARDS[combo * 2 + 1];
			const hasAs = a === As || b === As;
			const hasKd = a === Kd || b === Kd;
			if (hasAs !== hasKd) range[combo] = random() / 3;
		}
		const open = openMass(range);
		for (let combo = 0; combo < COMBOS; combo++) {
			const a = COMBO_CARDS[combo * 2];
			const b = COMBO_CARDS[combo * 2 + 1];
			if ((a === As && b === Kd) || (a === Kd && b === As)) expect(open[combo]).toBe(0);
		}
	});

	it('refuses to copy a subtree that starts inside a betting round', () => {
		// Investments are only level, and so known, where a round opens.
		const midRound = tree.edgeChild[tree.firstEdge[checked]];
		const sub = createRun(defineSpot(blueprint.subgameAt(checked, 0)), { analysisOnly: true });
		expect(() => copySubtree(sub.solver.ctx, run.solver.ctx, true, midRound)).toThrow(/opens a betting round/);
		expect(() => matchSubtree(sub.spot.tree, tree, midRound)).toThrow(/opens a betting round/);
	});

	it('refuses a node that does not open a betting round', () => {
		const midRound = tree.edgeChild[tree.firstEdge[checked]];
		expect(() => resolveSubgame(blueprint, midRound, 0, { player: 0 })).toThrow(/does not open a betting round/);
	});
});
