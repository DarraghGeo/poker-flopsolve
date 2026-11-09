/**
 * Line runouts (issue #53): coarser cards dealt in the betting lines a rule names.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { buildActiveLists } from '../src/cfr.ts';
import { buildHandSpace } from '../src/hands.ts';
import { cardClass, lineScales } from '../src/lines.ts';
import { parseCards } from '../src/cards.ts';
import { NodeKind } from '../src/tree.ts';

const turn: SpotConfig = {
	board: 'As Kh 7d 2c', pot: 60, stack: 180,
	oop: 'AA-TT,AKs,KQs,AKo,76s,54s', ip: 'QQ-88,AQs,QJs,JTs,T9s,AQo',
	betSizes: [[0.5]], raiseSizes: [[1]], maxRaises: 2,
};
const flop: SpotConfig = { ...turn, board: 'As Kh 7d', betSizes: [[0.75]], maxRaises: 2 };

describe('line runouts', () => {
	it('solve bit for bit as without them when the rule never fires', () => {
		const plain = createRun(defineSpot(flop), { engine: 'js' });
		const never = createRun(defineSpot({ ...flop, lineRunouts: { raises: 9 } }), { engine: 'js' });
		plain.step(8);
		never.step(8);
		expect(never.spot.estimate.bytes).toBe(plain.spot.estimate.bytes);
		expect(never.exploitabilityPercent()).toBe(plain.exploitabilityPercent());
		expect(Array.from(never.snapshot().handEvs(0))).toEqual(Array.from(plain.snapshot().handEvs(0)));
	});

	it('deal fewer cards only below the lines the rule names', () => {
		const plain = defineSpot(turn);
		const lines = defineSpot({ ...turn, lineRunouts: { raises: 1, band: 13 } });
		const { tree, runouts } = lines;
		const families = runouts.lines!.families;
		expect(runouts.approximate).toBe(true);
		// Storage less the per-board showdown tables, which every board keeps.
		const table = (spot: typeof plain): number => spot.runouts.counts[1] * (3 * 1326 + 1) * 2;
		expect(lines.estimate.bytes - table(lines)).toBeLessThan(plain.estimate.bytes - table(plain));
		for (const node of tree.decisionNodes) {
			const fam = families[runouts.lines!.family[node]];
			if (tree.round[node] === 0) continue;
			// A river reached without a turn raise sees every card.
			if (!fam.coarse) expect(fam.to - fam.from).toBe(plain.runouts.counts[1]);
			else expect(fam.to - fam.from).toBeLessThan(plain.runouts.counts[1] / 3);
		}
		const coarse = families.find((f) => f.coarse)!;
		// Every real river card is some stored board's member, once.
		const dealt: number[] = [];
		for (let b = coarse.from; b < coarse.to; b++) {
			for (let m = runouts.orbitStart[1][b]; m < runouts.orbitStart[1][b + 1]; m++) dealt.push(runouts.orbitCard[1][m]);
		}
		expect(dealt.length).toBe(48);
		expect(new Set(dealt).size).toBe(48);
	});

	it('class cards by what they do to pairs, flushes and straights', () => {
		const board = parseCards('As Kh 7d 2c');
		const of = (card: string, band = 13): number => cardClass(board, 0, 4, parseCards(card)[0], band);
		expect(of('3h')).toBe(of('4h')); // same suit count, both connect to A-2
		expect(of('3h')).not.toBe(of('9h')); // 9 connects to nothing below
		expect(of('Ad')).not.toBe(of('Kd')); // pairs keep their rank
		expect(of('Qs')).toBe(of('Qh')); // each a suit's second card
		expect(of('3h', 1)).not.toBe(of('4h', 1));
		const three = parseCards('As Kh 7d');
		const onFlop = (card: string): number => cardClass(three, 0, 3, parseCards(card)[0], 13);
		expect(onFlop('Qc')).not.toBe(onFlop('Qs')); // no club yet, a second spade
	});

	it('rescale only the deals a class folds', () => {
		const spot = defineSpot({ ...turn, lineRunouts: { aggressions: 1 } });
		const createdActive = buildActiveLists(spot.runouts, spot.players);
		const scales = lineScales(spot.runouts, spot.tree, createdActive, buildHandSpace(spot.runouts, spot.players, createdActive));
		let coarse = 0;
		for (let node = 0; node < spot.tree.nodeCount; node++) {
			if (spot.tree.kind[node] !== NodeKind.Chance) continue;
			const start = spot.runouts.lines!.chanceStart[node]!;
			const fam = spot.runouts.lines!.families.find((f) => f.childStart === start)!;
			if (!fam.coarse) expect(scales[node]).toBeNull();
			else {
				coarse++;
				expect(scales[node]).not.toBeNull();
				// A hand holding a stored card misses its class, so counts up.
				expect(Math.max(...scales[node]!.values)).toBeGreaterThan(1);
			}
		}
		expect(coarse).toBeGreaterThan(0);
	});

	it('measure their strategy in the full game, the same on threads', () => {
		const config = { ...flop, lineRunouts: { raises: 1, band: 3 } };
		const one = createRun(defineSpot(config), { engine: 'js' });
		const four = createRun(defineSpot(config), { engine: 'js', workers: 3 });
		one.step(25);
		four.step(25);
		const truth = one.trueExploitabilityPercent();
		expect(truth).toBeGreaterThan(0);
		expect(truth).toBeLessThan(5);
		// Thread count reassociates sums, as without line runouts.
		expect(four.trueExploitabilityPercent()).toBeCloseTo(truth, 4);
		four.close();
	});

	it('need a rule spelled out', () => {
		expect(() => defineSpot({ ...turn, lineRunouts: {} })).toThrow(/needs a rule/);
		expect(() => defineSpot({ ...turn, lineRunouts: { band: 3 } })).toThrow(/needs a rule/);
		expect(() => defineSpot({ ...turn, lineRunouts: { raises: 1.5 } })).toThrow(/whole number/);
		const banded = defineSpot({ ...turn, lineRunouts: { aggressions: 2 } });
		expect(banded.runouts.counts).toEqual(defineSpot({ ...turn, lineRunouts: { aggressions: 2, band: 3 } }).runouts.counts);
	});

	it('read boards per line', () => {
		const spot = defineSpot({ ...flop, lineRunouts: { aggressions: 1 } });
		const { tree, runouts } = spot;
		const lines = runouts.lines!;
		const coarseNode = Array.from(tree.decisionNodes).find((n) => lines.families[lines.family[n]].coarse && tree.round[n] === 1)!;
		const fineNode = Array.from(tree.decisionNodes).find((n) => !lines.families[lines.family[n]].coarse && tree.round[n] === 1)!;
		const coarse = lines.families[lines.family[coarseNode]];
		const fine = lines.families[lines.family[fineNode]];
		const run = createRun(spot, { engine: 'js' });
		run.step(2);
		const solution = run.snapshot();
		expect(() => solution.strategyAt(coarseNode, fine.from)).toThrow(/line/);
		expect(() => solution.reachAt(coarseNode, fine.from, 0)).toThrow(/line/);
		expect(solution.strategyAt(coarseNode, coarse.from).probs.length).toBeGreaterThan(0);
		// A real turn resolves to a board of the line asked about.
		const resolved = spot.resolveBoard('As Kh 7d 5c', coarseNode);
		expect(resolved.board).toBeGreaterThanOrEqual(coarse.from);
		expect(resolved.board).toBeLessThan(coarse.to);
		const plain = spot.resolveBoard('As Kh 7d 5c', fineNode);
		expect(plain.board).toBeGreaterThanOrEqual(fine.from);
		expect(plain.board).toBeLessThan(fine.to);
		// Past the node's round, its line carries on as it is.
		const river = spot.resolveBoard('As Kh 7d 5c 9h', 0);
		expect(river.round).toBe(2);
		expect(runouts.parent[2][river.board]).toBe(spot.resolveBoard('As Kh 7d 5c', 0).board);
		expect(() => spot.resolveBoard('As Kh 7d 5c', tree.nodeCount)).toThrow(/not a node/);
		run.close();
	});

	it('view each parent\'s own line in childStart, every child its own', () => {
		const spot = defineSpot({ ...flop, lineRunouts: { raises: 1 } });
		const { runouts } = spot;
		for (let round = 1; round < runouts.rounds; round++) {
			const starts = runouts.childStart[round];
			for (let p = 0; p < runouts.counts[round - 1]; p++) {
				expect(starts[p + 1]).toBeGreaterThanOrEqual(starts[p]);
				for (let c = starts[p]; c < starts[p + 1]; c++) expect(runouts.parent[round][c]).toBe(p);
			}
		}
		// The fine turns' own children are their fine rivers.
		const fine = runouts.lines!.families.find((f) => f.round === 2 && !f.coarse)!;
		expect(runouts.childStart[2][0]).toBe(fine.childStart[0]);
	});

	it('value hands against one opposing hand, as the walk with every hand apart does', () => {
		const spot = defineSpot({ ...flop, lineRunouts: { aggressions: 1 } });
		const run = createRun(spot, { engine: 'js' });
		run.step(3);
		const { solver } = run;
		const theirs = new Float64Array(1326);
		const one = spot.players[1].combos[0];
		theirs[one] = 1;
		const values = solver.valuesAt(0, 0, 0, spot.players[0].weights, theirs, solver.rootLive, solver.rootCount);
		const rows = solver.pairValuesAt(0, 0, 0, Uint16Array.of(one), Float64Array.of(1), solver.rootLive, solver.rootCount);
		for (const combo of spot.players[0].combos) expect(values[combo]).toBeCloseTo(rows[combo], 9);
		expect(values.some((v) => v !== 0)).toBe(true);
		run.close();
	});

	it('split threads by the boards below each', async () => {
		const { planShards } = await import('../src/parallel.ts');
		const spot = defineSpot({ ...flop, lineRunouts: { raises: 1 } });
		const plan = planShards(spot.tree, spot.runouts, 4)!;
		const weight = (from: number, to: number): number => {
			let sum = 0;
			for (const fam of spot.runouts.lines!.families) {
				if (fam.round !== 2) continue;
				const above = spot.runouts.lines!.families[fam.parent];
				for (let b = Math.max(from, above.from); b < Math.min(to, above.to); b++) sum += fam.childStart[b + 1] - fam.childStart[b];
			}
			return sum;
		};
		const shares = [0, 1, 2, 3].map((w) => weight(plan.bounds[w], plan.bounds[w + 1]));
		expect(Math.min(...shares) / Math.max(...shares)).toBeGreaterThan(0.8);
		expect(plan.bounds[4]).toBe(spot.runouts.counts[1]);
	});

	it('refuse what they do not combine with', () => {
		const spot = defineSpot({ ...turn, lineRunouts: { raises: 1 } });
		expect(createRun(spot).engine).toBe('js');
		expect(() => createRun(spot, { approximations: { chanceSampling: {} } })).toThrow(/lineRunouts/);
		expect(() => createRun(spot, { approximations: { coarseStart: { iterations: 5 } } })).toThrow(/lineRunouts/);
		expect(() => defineSpot({ ...turn, lineRunouts: { raises: 1, band: 0 } })).toThrow(/band/);
	});
});
