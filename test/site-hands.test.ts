import { describe, expect, it } from 'vitest';
import { COMBO_CARDS, parseCards, parseRange } from '../src/index.ts';
import {
	CELLS,
	cellCombos,
	cellKind,
	cellLabel,
	cellOfCards,
	cellsFromCombos,
	comboCount,
	paintCell,
	rangeOfCells,
	rangeOfCombos,
	TOTAL_COMBOS,
} from '../site/lib/hands.ts';

const cellNamed = (label: string): number => {
	for (let cell = 0; cell < CELLS; cell++) if (cellLabel(cell) === label) return cell;
	throw new Error(label);
};

const gridOf = (range: string): Float64Array => cellsFromCombos(parseRange(range), COMBO_CARDS);

describe('site hand grid', () => {
	it('lays out pairs on the diagonal, suited above, offsuit below', () => {
		expect(cellLabel(0)).toBe('AA');
		expect(cellLabel(1)).toBe('AKs');
		expect(cellLabel(13)).toBe('AKo');
		expect(cellLabel(168)).toBe('22');
		expect(cellKind(cellNamed('72o'))).toBe('offsuit');
		let total = 0;
		for (let cell = 0; cell < CELLS; cell++) total += cellCombos(cell);
		expect(total).toBe(TOTAL_COMBOS);
	});

	it('puts every combination in its own class', () => {
		const [as, ks, kh, two, twoS] = parseCards('As Ks Kh 2c 2s');
		expect(cellLabel(cellOfCards(as, ks))).toBe('AKs');
		expect(cellLabel(cellOfCards(kh, as))).toBe('AKo');
		expect(cellLabel(cellOfCards(two, twoS))).toBe('22');
		expect(cellLabel(cellOfCards(two, kh))).toBe('K2o');
	});

	it('averages partial classes and counts combinations', () => {
		const grid = gridOf('AA,AsKs,QQ:0.5');
		expect(grid[cellNamed('AA')]).toBe(1);
		expect(grid[cellNamed('AKs')]).toBe(0.25);
		expect(grid[cellNamed('QQ')]).toBe(0.5);
		expect(comboCount(grid)).toBe(6 + 1 + 3);
	});

	it('compresses notation', () => {
		expect(rangeOfCells(gridOf('22+'))).toBe('22+');
		expect(rangeOfCells(gridOf('TT+,77,55-33'))).toBe('TT+,77,55-33');
		expect(rangeOfCells(gridOf('A2s+,K9s-K6s,AQo+,KJo'))).toBe('A2s+,K9s-K6s,AQo+,KJo');
		expect(rangeOfCells(gridOf('AA,KK:0.5,AKs:0.5,QQ:0.25'))).toBe('AA,KK:0.5,AKs:0.5,QQ:0.25');
		expect(rangeOfCells(new Float64Array(CELLS))).toBe('');
	});

	it('round-trips any grid through the solver parser', () => {
		let seed = 7;
		const random = (): number => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed / 2 ** 31;
		};
		const weights = [0, 0, 0, 1, 1, 0.5, 0.25, 0.75];
		for (let trial = 0; trial < 50; trial++) {
			const grid = new Float64Array(CELLS);
			for (let cell = 0; cell < CELLS; cell++) grid[cell] = weights[Math.floor(random() * weights.length)];
			expect([...gridOf(rangeOfCells(grid))]).toEqual([...grid]);
		}
	});

	it('keeps single combinations and exact weights when another cell is painted', () => {
		const weights = parseRange('AA,AsKs,KK:0.333');
		paintCell(weights, COMBO_CARDS, cellNamed('QQ'), 1);
		const range = rangeOfCombos(weights, COMBO_CARDS);
		expect([...parseRange(range)]).toEqual([...parseRange('AA,AsKs,KK:0.333,QQ')]);
		expect(range).toBe('AA,QQ,KK:0.333,AsKs');
		paintCell(weights, COMBO_CARDS, cellNamed('AKs'), 0);
		expect(rangeOfCombos(weights, COMBO_CARDS)).toBe('AA,QQ,KK:0.333');
	});
});
