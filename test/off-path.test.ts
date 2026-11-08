import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, type SolveOptions } from '../src/index.ts';
import { NodeKind } from '../src/tree.ts';

/**
 * A hand that equilibrium play stops sending to a node still has a strategy
 * there, and anything that continues it off the path (a user browsing the
 * hand, an engine compared against the solve) plays that strategy. With sums
 * weighted by the hand's own reach, the near-uniform first iterations dominate
 * what little it adds later, so it would fold, call and raise at about equal
 * shares. Sums that count each iteration's strategy whatever the hand's reach
 * give it the strategy its regrets have settled on instead. On this spot
 * after 300 iterations that took near-uniform play among barely-reached hands
 * from about 8% to 0.6% (from 1.8% to 0.7% at 16-bit precision, where #7
 * already caught sums rounded to zero); what is left mixes close to evenly.
 */

const turn = () =>
	defineSpot({
		board: '2c7d9hJs', pot: 100, stack: 200, oop: 'JJ,TT,54s,AA,KQo,Q8s,A2o', ip: 'TT,99,A5s,QQ,K7s,KJo,86s',
		betSizes: [[0.33, 1]], maxRaises: 2,
	});

/** Barely-reached hands, and how many of them play every action at about an equal share. */
function nearUniform(options: SolveOptions, iterations: number): { engine: string; barely: number; uniform: number } {
	const run = createRun(turn(), options);
	const engine = run.engine;
	run.step(iterations);
	const solution = run.snapshot();
	const lists = run.solver.ctx.active;
	run.close();
	const { spot } = solution;
	const tree = spot.tree;
	let barely = 0;
	let uniform = 0;
	for (const node of tree.decisionNodes) {
		if (tree.kind[node] !== NodeKind.Decision) continue;
		const player = tree.player[node] as 0 | 1;
		const index = spot.players[player];
		const round = tree.round[node];
		for (let board = 0; board < spot.runouts.counts[round]; board++) {
			const reach = solution.reachAt(node, board, player);
			const { actions, probs } = solution.strategyAt(node, board);
			const count = actions.length;
			// Only the hands the board leaves live; one that shares a card
			// with it is never stored and has nothing to say there.
			const listSlot = (lists.roundBase[round] + board) * 2 + player;
			for (let k = 0; k < lists.count[listSlot]; k++) {
				const i = lists.slot[lists.start[listSlot] + k];
				const combo = index.combos[i];
				const start = index.weights[combo];
				if (start <= 0 || reach[combo] <= 0 || reach[combo] >= 1e-3 * start) continue;
				barely++;
				let all = true;
				for (let a = 0; a < count; a++) if (Math.abs(probs[i * count + a] - 1 / count) > 0.05) all = false;
				if (all) uniform++;
			}
		}
	}
	return { engine, barely, uniform };
}

describe('hands that equilibrium stops sending to a node', () => {
	for (const engine of ['js', 'wasm'] as const) {
		it(`do not play near-uniformly there (${engine} engine)`, () => {
			// WebAssembly is the default at 32 bits; 'js' is the only override.
			const result = nearUniform(engine === 'js' ? { engine, precision: 'f32' } : { precision: 'f32' }, 300);
			const { barely, uniform } = result;
			expect(result.engine).toBe(engine);
			expect(barely).toBeGreaterThan(100);
			expect(uniform).toBeLessThan(barely * 0.012);
		});
	}

	it('do not play near-uniformly there at 16-bit precision', () => {
		const { barely, uniform } = nearUniform({ precision: 'i16' }, 300);
		expect(barely).toBeGreaterThan(100);
			expect(uniform).toBeLessThan(barely * 0.012);
	});
});
