import { describe, expect, it } from 'vitest';
import { COMBO_CARDS, COMBOS, formatCombo, rankOf, suitOf } from '../src/cards.ts';
import { activeCombos, parseRange, rangeWeight } from '../src/range.ts';

const count = (notation: string): number => activeCombos(parseRange(notation)).length;

describe('range notation', () => {
	it('counts the standard classes', () => {
		expect(count('AA')).toBe(6);
		expect(count('AKs')).toBe(4);
		expect(count('AKo')).toBe(12);
		expect(count('AK')).toBe(16);
		expect(count('AsKh')).toBe(1);
	});

	it('expands "and better"', () => {
		expect(count('22+')).toBe(13 * 6);
		expect(count('QQ+')).toBe(3 * 6);
		// A2s+ climbs the low card to just under the ace: A2s..AQs, twelve of them.
		expect(count('A2s+')).toBe(12 * 4);
		expect(count('KTs+')).toBe(3 * 4);
		// ATo, AJo, AQo, AKo — the low card climbs to just under the ace.
		expect(count('ATo+')).toBe(4 * 12);
		expect(count('AKo+')).toBe(12);
	});

	it('expands spans in either direction', () => {
		// 99, TT, JJ, QQ, KK.
		expect(count('KK-99')).toBe(5 * 6);
		expect(count('99-KK')).toBe(5 * 6);
		expect(count('A5s-A2s')).toBe(4 * 4);
		expect(count('A2s-A5s')).toBe(4 * 4);
	});

	it('expands wildcards, and knows a pair cannot be suited', () => {
		expect(count('AXs')).toBe(12 * 4);
		expect(count('AXo')).toBe(12 * 12 + 6);
		expect(count('Ax')).toBe(12 * 16 + 6);
	});

	it('covers the whole deck with random', () => {
		expect(count('random')).toBe(COMBOS);
		expect(rangeWeight(parseRange('random'))).toBe(COMBOS);
	});

	it('combines segments', () => {
		expect(count('AA,KK,AKs')).toBe(6 + 6 + 4);
		// Overlaps are not double counted.
		expect(count('AA,AA')).toBe(6);
		expect(count('22+,AA')).toBe(13 * 6);
	});
});

describe('weights', () => {
	it('applies a weight to a segment', () => {
		const weights = parseRange('AA:0.5');
		expect(rangeWeight(weights)).toBeCloseTo(3, 10);
		for (const combo of activeCombos(weights)) expect(weights[combo]).toBe(0.5);
	});

	it('accepts percentages', () => {
		expect(rangeWeight(parseRange('AA:25%'))).toBeCloseTo(1.5, 10);
	});

	it('lets a later segment override an earlier one', () => {
		// The idiom for "a light range, but aces always".
		const weights = parseRange('random:0.1, AA:1');
		expect(rangeWeight(weights)).toBeCloseTo((COMBOS - 6) * 0.1 + 6, 8);
		const aces = activeCombos(parseRange('AA'));
		for (const combo of aces) expect(weights[combo]).toBe(1);
	});

	it('rejects a weight outside zero to one', () => {
		expect(() => parseRange('AA:1.5')).toThrow(/between 0 and 1/);
		expect(() => parseRange('AA:-1')).toThrow(/between 0 and 1/);
	});
});

describe('bad input', () => {
	it('names what it could not read', () => {
		expect(() => parseRange('ZZ')).toThrow(/Unrecognised|Invalid rank/);
		expect(() => parseRange('AAs')).toThrow(/a pair cannot be suited/);
		expect(() => parseRange('AsAs')).toThrow(/same card twice/);
		expect(() => parseRange('A5s-K2s')).toThrow(/higher rank fixed/);
	});
});

describe('combination indexing', () => {
	it('produces the cards the label claims', () => {
		const weights = parseRange('AKs');
		for (const combo of activeCombos(weights)) {
			const a = COMBO_CARDS[combo * 2];
			const b = COMBO_CARDS[combo * 2 + 1];
			expect(suitOf(a)).toBe(suitOf(b));
			expect(new Set([rankOf(a), rankOf(b)])).toEqual(new Set([12, 11]));
		}
		expect(activeCombos(parseRange('AsKs')).map(formatCombo)).toEqual(['AsKs']);
	});

	it('never puts two combinations in the same slot', () => {
		// Every class must occupy exactly as many distinct slots as it has
		// combinations; a collision here would silently merge hands.
		const all = parseRange('random');
		expect(activeCombos(all).length).toBe(COMBOS);
	});
});
