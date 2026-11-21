/**
 * Range compression (issue #156): `compressRanges` on its own, and as
 * `solveLite`'s `compressRanges` option.
 */

import { describe, expect, it } from 'vitest';
import {
	COMBO_CARDS, COMBOS, compressRanges, createRun, defineSpot, exploitabilityInExact, liteConfig, litePreset, NodeKind, parseCards, parseRange, solveLite,
} from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const spot: SpotConfig = { board: 'Ts 9s 4h', pot: 55, stack: 975, oop: OOP, ip: IP, betSizes: [[0.75]], maxRaises: 1 };

/** Combinations with weight. */
const live = (weights: Float64Array): number[] => [...weights.keys()].filter((combo) => weights[combo] > 0);

describe('compressRanges', () => {
	it('keeps a re-weighted subset of each range within the tolerance', () => {
		const board = new Set(parseCards(spot.board));
		const { oop, ip, report } = compressRanges(spot, { tolerance: 0.02 });
		for (const [weights, notation, change] of [[oop, OOP, report[0]], [ip, IP, report[1]]] as const) {
			const before = parseRange(notation);
			const kept = live(weights);
			expect(weights.length).toBe(COMBOS);
			expect(kept.length).toBe(change.to);
			expect(change.to).toBeLessThan(change.from);
			expect(change.from).toBe(live(before).filter((c) => !board.has(COMBO_CARDS[c * 2]) && !board.has(COMBO_CARDS[c * 2 + 1])).length);
			// A subset of the range, off the board, the heaviest at 1.
			for (const combo of kept) {
				expect(before[combo]).toBeGreaterThan(0);
				expect(board.has(COMBO_CARDS[combo * 2]) || board.has(COMBO_CARDS[combo * 2 + 1])).toBe(false);
			}
			expect(Math.max(...weights)).toBeCloseTo(1, 12);
			expect(change.mismatch).toBeGreaterThan(0);
			expect(change.mismatch).toBeLessThanOrEqual(0.0201);
		}
	});

	it('goes further at a looser tolerance, and to a given size', () => {
		const tight = compressRanges(spot, { tolerance: 0.005 }).report;
		const loose = compressRanges(spot, { tolerance: 0.03 }).report;
		expect(loose[0].to).toBeLessThan(tight[0].to);
		expect(loose[1].to).toBeLessThan(tight[1].to);
		const sized = compressRanges(spot, { size: [120, 100] }).report;
		expect(sized[0].to).toBeLessThanOrEqual(120);
		expect(sized[0].to).toBeGreaterThan(110);
		expect(sized[1].to).toBeLessThanOrEqual(100);
		expect(sized[1].to).toBeGreaterThan(90);
	});

	it('keeps ranges the same in the suits the flop treats alike', () => {
		// Ts 9s 4h: diamonds and clubs are interchangeable.
		const { oop } = compressRanges(spot, { tolerance: 0.02 });
		const swap = (card: number): number => { const suit = card & 3; return suit === 2 ? card + 1 : suit === 3 ? card - 1 : card; };
		const index = new Map<string, number>();
		for (let combo = 0; combo < COMBOS; combo++) index.set(`${COMBO_CARDS[combo * 2]},${COMBO_CARDS[combo * 2 + 1]}`, combo);
		for (const combo of live(oop)) {
			const [a, b] = [swap(COMBO_CARDS[combo * 2]), swap(COMBO_CARDS[combo * 2 + 1])].sort((x, y) => x - y);
			expect(oop[index.get(`${a},${b}`)!]).toBeCloseTo(oop[combo], 12);
		}
	});

	it('applies minWeight to the ranges as given', () => {
		const light: SpotConfig = { ...spot, oop: `${OOP},72o:0.01` };
		expect(compressRanges({ ...light, minWeight: 0.05 }).report[0].from).toBe(compressRanges(spot).report[0].from);
		expect(compressRanges(light).report[0].from).toBeGreaterThan(compressRanges(spot).report[0].from);
	});

	it('is the same every time', () => {
		expect(compressRanges(spot).oop).toEqual(compressRanges(spot).oop);
	});

	it('refuses a turn or river board and bad settings', () => {
		expect(() => compressRanges({ ...spot, board: 'Ts 9s 4h 2c' })).toThrow(/flop/);
		expect(() => compressRanges(spot, { tolerance: 0 })).toThrow(/tolerance/);
		expect(() => compressRanges(spot, { size: 1 })).toThrow(/size/);
		expect(() => compressRanges({ ...spot, oop: 'TsTh' })).toThrow(/empty/);
	});
});

describe('solveLite with compressRanges', () => {
	it('is off unless asked', () => {
		expect(liteConfig(spot).oop).toBe(OOP);
		expect(litePreset(spot).changes.settings.some((s) => s.setting === 'compressRanges')).toBe(false);
	});

	it('puts the compressed ranges in the blueprint and says so', () => {
		const direct = compressRanges(spot, { tolerance: 0.02 });
		const lite = liteConfig({ ...spot, minWeight: 0.05 }, { compressRanges: { tolerance: 0.02 } });
		expect(lite.oop).toEqual(direct.oop);
		expect(lite.ip).toEqual(direct.ip);
		expect(lite.minWeight).toBeUndefined();
		expect(liteConfig(spot, { compressRanges: true }).oop).toEqual(compressRanges(spot).oop);
		const { changes } = litePreset(spot, { compressRanges: { tolerance: 0.02 } });
		expect(changes.settings.find((s) => s.setting === 'compressRanges')?.to).toEqual({ tolerance: 0.02 });
		expect(changes.notes.some((note) => note.includes(`${direct.report[0].to} and ${direct.report[1].to}`))).toBe(true);
	});

	it('re-solves a turn and is measured in the full game from the compressed blueprint', () => {
		const tiny: SpotConfig = { ...spot, pot: 60, stack: 60, betSizes: [[1]], maxRaises: 1 };
		const lite = solveLite(tiny, { compressRanges: { tolerance: 0.03 }, iterations: 30, settle: false, sampling: false });
		const { tree } = lite.solution.spot;
		const node = [...tree.kind.keys()].find((n) => tree.round[n] === 1 && tree.kind[n] === NodeKind.Decision)!;
		const turn = lite.resolve(node, 0, { player: 0, iterations: 10 });
		// The subgame is solved for the ranges the blueprint brings: no combination it never held.
		expect(turn.solution.spot.players[0].count).toBeLessThanOrEqual(lite.solution.spot.players[0].count);
		expect(turn.solution.spot.players[0].count).toBeGreaterThan(0);
		const exact = createRun(defineSpot(tiny), {});
		exact.step(20);
		const exploitable = exploitabilityInExact(lite.solution, exact);
		expect(exploitable).toBeGreaterThan(0);
		expect(Number.isFinite(exploitable)).toBe(true);
	});

	it('takes a range on any scale', () => {
		const scaled = parseRange(OOP).map((weight) => weight * 1e-7);
		expect(compressRanges({ ...spot, oop: scaled }).oop).toEqual(compressRanges(spot).oop);
	});

	it('solves the compressed ranges, with a strategy only for the combinations kept', () => {
		const tiny: SpotConfig = { ...spot, pot: 60, stack: 60, betSizes: [[1]], maxRaises: 1 };
		const direct = compressRanges(tiny, { tolerance: 0.03 });
		const lite = solveLite(tiny, { compressRanges: { tolerance: 0.03 }, iterations: 20, settle: false, sampling: false });
		expect(lite.source).toBe(tiny);
		expect(lite.solution.spot.players[0].count).toBe(direct.report[0].to);
		expect(lite.solution.spot.players[1].count).toBe(direct.report[1].to);
		const root = lite.solution.strategyAt(0, 0);
		expect([...root.combos].sort((a, b) => a - b)).toEqual(live(direct.oop));
	});
});
