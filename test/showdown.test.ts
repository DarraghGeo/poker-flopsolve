import { describe, expect, it } from 'vitest';
import { COMBO_CARDS, COMBOS, formatCombo, parseCards } from '../src/cards.ts';
import { enumerateRunouts } from '../src/runouts.ts';
import {
	buildShowdownTable,
	foldValues,
	makeTerminalScratch,
	showdownValues,
} from '../src/showdown.ts';

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Two combinations can be held at once only if they share no card. */
function disjoint(x: number, y: number): boolean {
	const a = COMBO_CARDS[x * 2];
	const b = COMBO_CARDS[x * 2 + 1];
	const c = COMBO_CARDS[y * 2];
	const d = COMBO_CARDS[y * 2 + 1];
	return a !== c && a !== d && b !== c && b !== d;
}

const BOARDS = ['As Kh 7d 2c 9s', 'Ts 9s 8s 2h 2d', 'Ah Ad Ac Kh Kd', 'As Kh 7d 2c', 'Qs Jh 4d'];

describe('terminal kernels match brute force', () => {
	it.each(BOARDS)('board %s', (text) => {
		const runouts = enumerateRunouts(parseCards(text));
		const table = buildShowdownTable(runouts);
		const scratch = makeTerminalScratch();
		const out = new Float64Array(COMBOS);
		const reach = new Float64Array(COMBOS);
		const random = mulberry32(0xbeef + text.length);

		// A spread of final boards rather than all of them.
		const step = Math.max(1, Math.floor(table.boards / 6));
		for (let board = 0; board < table.boards; board += step) {
			const live = table.order.subarray(board * COMBOS, board * COMBOS + table.liveCount[board]);
			const count = table.liveCount[board];

			// Weighted, not uniform — a solver range is partial by nature, and a
			// kernel that only works at weight 1 would pass a uniform test.
			reach.fill(0);
			for (let i = 0; i < count; i++) reach[live[i]] = random() * (random() < 0.3 ? 0 : 1);

			// Strength rank from the tie groups: same group means an exact chop.
			const rank = new Int32Array(COMBOS).fill(-1);
			const groupBase = board * (COMBOS + 1);
			for (let g = 0; g < table.groupCount[board]; g++) {
				for (let i = table.groupStart[groupBase + g]; i < table.groupStart[groupBase + g + 1]; i++) {
					rank[live[i]] = g;
				}
			}

			const payoff = 13;

			showdownValues(reach, table, board, payoff, scratch, out);
			for (let i = 0; i < count; i++) {
				const hero = live[i];
				let expected = 0;
				for (let j = 0; j < count; j++) {
					const villain = live[j];
					if (!disjoint(hero, villain)) continue;
					if (rank[hero] > rank[villain]) expected += reach[villain];
					else if (rank[hero] < rank[villain]) expected -= reach[villain];
				}
				expect(out[hero], `${formatCombo(hero)} on board ${board}`).toBeCloseTo(payoff * expected, 9);
			}

			foldValues(reach, live as Uint16Array, count, payoff, scratch, out);
			for (let i = 0; i < count; i++) {
				const hero = live[i];
				let expected = 0;
				for (let j = 0; j < count; j++) {
					if (disjoint(hero, live[j])) expected += reach[live[j]];
				}
				expect(out[hero], `${formatCombo(hero)} fold on board ${board}`).toBeCloseTo(payoff * expected, 9);
			}
		}
	});
});

describe('runouts', () => {
	it('counts completions for each entry point', () => {
		expect(enumerateRunouts(parseCards('As Kh 7d')).counts).toEqual([1, 49, 49 * 48]);
		expect(enumerateRunouts(parseCards('As Kh 7d 2c')).counts).toEqual([1, 48]);
		expect(enumerateRunouts(parseCards('As Kh 7d 2c 9s')).counts).toEqual([1]);
	});

	it('never repeats a card and always extends its parent', () => {
		const runouts = enumerateRunouts(parseCards('As Kh 7d'));
		const last = runouts.rounds - 1;
		const width = runouts.width[last];
		for (let board = 0; board < runouts.counts[last]; board += 17) {
			const cards = Array.from(runouts.cards[last].subarray(board * width, board * width + width));
			expect(new Set(cards).size).toBe(width);
			// The flop must still be the first three cards.
			expect(cards.slice(0, 3)).toEqual(runouts.initial);
		}
	});

	it('leaves exactly the board-blocked hands out', () => {
		const runouts = enumerateRunouts(parseCards('As Kh 7d 2c 9s'));
		const table = buildShowdownTable(runouts);
		// C(52,2) - C(47,2) = 1326 - 1081 = 245 combinations use a board card.
		expect(table.liveCount[0]).toBe(1081);
	});

	it('rejects boards that are not postflop', () => {
		expect(() => enumerateRunouts(parseCards('As Kh'))).toThrow(/3, 4 or 5 cards/);
		expect(() => enumerateRunouts([0, 1, 2, 3, 4, 5])).toThrow(/3, 4 or 5 cards/);
	});
});
