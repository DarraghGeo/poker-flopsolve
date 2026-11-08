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
		const lines = defineSpot({ ...turn, lineRunouts: { raises: 1 } });
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
		expect(four.trueExploitabilityPercent()).toBeCloseTo(truth, 6);
		four.close();
	});

	it('refuse what they do not combine with', () => {
		const spot = defineSpot({ ...turn, lineRunouts: { raises: 1 } });
		expect(createRun(spot).engine).toBe('js');
		expect(() => createRun(spot, { approximations: { chanceSampling: {} } })).toThrow(/lineRunouts/);
		expect(() => defineSpot({ ...turn, lineRunouts: { raises: 1, band: 0 } })).toThrow(/band/);
	});
});
