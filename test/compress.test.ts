/**
 * Range compression (issue #156): `compressRanges` on its own, and as
 * `solveLite`'s `compressRanges` option; on a flop, and on a spot that
 * starts on the turn or the river (issue #158). And the combinations a
 * compressed solve left out, put back at the next street: `rebuildRanges`,
 * and `LiteSolution.resolve`'s use of it.
 */

import { describe, expect, it } from 'vitest';
import {
	COMBO_CARDS, COMBOS, compressRanges, createRun, defineSpot, exploitabilityInExact, liteConfig, litePreset, NodeKind, openLite, parseCards, parseRange,
	rebuildRanges, resolveSubgame, solve, solveLite, STAND_INS,
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

	it.each([
		['turn', 'Ts 9s 4h 2c'],
		['river', 'Ts 9s 4h 2c 2d'],
	])('compresses the ranges of a spot that starts on the %s', (_street, cards) => {
		const board = new Set(parseCards(cards));
		const { oop, ip, report } = compressRanges({ ...spot, board: cards });
		// Past the flop the default tolerance is 0.005.
		expect(oop).toEqual(compressRanges({ ...spot, board: cards }, { tolerance: 0.005 }).oop);
		[OOP, IP].forEach((text, p) => {
			const before = parseRange(text);
			const after = [oop, ip][p];
			expect(report[p].from).toBe(live(before).filter((c) => !board.has(COMBO_CARDS[c * 2]) && !board.has(COMBO_CARDS[c * 2 + 1])).length);
			expect(report[p].to).toBe(live(after).length);
			expect(report[p].to).toBeLessThan(report[p].from);
			expect(report[p].mismatch).toBeLessThanOrEqual(0.00505);
			for (const combo of live(after)) {
				expect(before[combo]).toBeGreaterThan(0);
				expect(board.has(COMBO_CARDS[combo * 2]) || board.has(COMBO_CARDS[combo * 2 + 1])).toBe(false);
			}
			expect(Math.max(...after)).toBeCloseTo(1, 12);
		});
		// A looser tolerance keeps fewer, and a size is met.
		const loose = compressRanges({ ...spot, board: cards }, { tolerance: 0.03 });
		expect(loose.report[0].to).toBeLessThanOrEqual(report[0].to);
		const sized = compressRanges({ ...spot, board: cards }, { size: [40, 30] }).report;
		expect(sized[0].to).toBeLessThanOrEqual(40);
		expect(sized[1].to).toBeLessThanOrEqual(30);
		// The order the board's cards are written in changes nothing.
		const shuffled = cards.split(' ').reverse().join(' ');
		expect(compressRanges({ ...spot, board: shuffled }).oop).toEqual(oop);
		expect(compressRanges({ ...spot, board: shuffled }).ip).toEqual(ip);
	});

	it('gives a river spot more to keep than its equity histogram', () => {
		// Sixteen bins on one board would be met by a few dozen combinations at
		// any tolerance; what the other player's hands face asks for more.
		const tight = compressRanges({ ...spot, board: 'Ts 9s 4h 2c 2d' }, { tolerance: 0.0005 });
		expect(tight.report[0].to).toBeGreaterThan(64);
		expect(tight.report[1].to).toBeGreaterThan(64);
	});

	it('refuses a board that is not 3, 4 or 5 cards and bad settings', () => {
		expect(() => compressRanges({ ...spot, board: 'Ts 9s' })).toThrow(/3, 4 or 5 cards/);
		expect(() => compressRanges({ ...spot, board: 'Ts 9s 4h 2c 2d 2h' })).toThrow(/3, 4 or 5 cards/);
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
		const turn = lite.resolve(node, 0, { player: 0, iterations: 10, rebuild: false });
		// Without rebuilding, the subgame is solved for the ranges the blueprint brings: no combination it never held.
		expect(turn.solution.spot.players[0].count).toBeLessThanOrEqual(lite.solution.spot.players[0].count);
		expect(turn.solution.spot.players[0].count).toBeGreaterThan(0);
		const exact = createRun(defineSpot(tiny), {});
		exact.step(20);
		const exploitable = exploitabilityInExact(lite.solution, exact);
		expect(exploitable).toBeGreaterThan(0);
		expect(Number.isFinite(exploitable)).toBe(true);
	});

	it('compresses a turn spot under Lite and solves it', () => {
		const turn: SpotConfig = { ...spot, board: 'Ts 9s 4h 2c', pot: 60, stack: 60, betSizes: [[1]], maxRaises: 1 };
		const direct = compressRanges(turn, { tolerance: 0.03 });
		expect(liteConfig(turn, { compressRanges: { tolerance: 0.03 } }).oop).toEqual(direct.oop);
		const lite = solveLite(turn, { compressRanges: { tolerance: 0.03 }, iterations: 20, settle: false, sampling: false });
		expect(lite.solution.spot.players[0].count).toBe(direct.report[0].to);
		expect(lite.solution.spot.players[1].count).toBe(direct.report[1].to);
		expect([...lite.solution.strategyAt(0, 0).combos].sort((a, b) => a - b)).toEqual(live(direct.oop));
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

describe('rebuildRanges', () => {
	const tiny: SpotConfig = { ...spot, pot: 60, stack: 60, betSizes: [[1]], maxRaises: 1 };
	const compressed = compressRanges(tiny, { tolerance: 0.03, standIns: true });
	const solution = solve(defineSpot({ ...tiny, oop: compressed.oop, ip: compressed.ip }), { iterations: 30 });
	const { tree, runouts } = solution.spot;
	const opening = (round: number): number => [...tree.kind.keys()].find((n) => tree.round[n] === round && tree.kind[n] === NodeKind.Decision)!;
	/** The source range's combinations off the flop. */
	const held = (text: string): number[] => {
		const flop = new Set(parseCards(tiny.board));
		return live(parseRange(text)).filter((c) => !flop.has(COMBO_CARDS[c * 2]) && !flop.has(COMBO_CARDS[c * 2 + 1]));
	};

	it('lists stand-ins only when asked: kept combinations, nearest first, a kept one its own', () => {
		expect(compressRanges(tiny, { tolerance: 0.03 }).standIns).toBeUndefined();
		[OOP, IP].forEach((text, p) => {
			const map = compressed.standIns![p];
			const kept = [compressed.oop, compressed.ip][p];
			expect(map.length).toBe(COMBOS * STAND_INS);
			const mine = held(text);
			for (let combo = 0; combo < COMBOS; combo++) {
				const list = [...map.subarray(combo * STAND_INS, (combo + 1) * STAND_INS)];
				if (!mine.includes(combo)) {
					expect(list.every((x) => x === -1)).toBe(true);
					continue;
				}
				const given = list.filter((x) => x >= 0);
				expect(given.length).toBeGreaterThan(0);
				expect(new Set(given).size).toBe(given.length);
				for (const standIn of given) expect(kept[standIn]).toBeGreaterThan(0);
				if (kept[combo] > 0) expect(list[0]).toBe(combo);
			}
		});
	});

	it('puts every combination of the source back at a turn, a kept one at its own reach', () => {
		const node = opening(1);
		const ranges = rebuildRanges(tiny, compressed, solution, node, 0);
		[OOP, IP].forEach((text, p) => {
			const out = ranges[p];
			expect(live(out)).toEqual(held(text));
			expect(Math.max(...out)).toBeCloseTo(1, 12);
			// Kept combinations: source weight times their own share of the way here, to one scale.
			const source = parseRange(text);
			const reach = solution.reachAt(node, 0, p as 0 | 1);
			const start = solution.spot.players[p].weights;
			const kept = live([compressed.oop, compressed.ip][p]);
			const want = kept.map((c) => source[c] * Math.max(0.005, reach[c] / start[c]));
			const scale = out[kept[0]] / want[0];
			kept.forEach((c, i) => expect(out[c]).toBeCloseTo(want[i] * scale, 10));
			// A combination left out follows a kept one: its weight is its own times a share some kept one has.
			const shares = new Set(kept.map((c) => (Math.max(0.005, reach[c] / start[c]) * scale).toFixed(9)));
			for (const c of held(text)) expect(shares.has((out[c] / source[c]).toFixed(9))).toBe(true);
		});
	});

	it('passes over a stand-in that holds the turn card when rebuilding at a river', () => {
		const node = opening(2);
		const width = runouts.width[2];
		let passedOver = 0;
		for (const board of [0, runouts.counts[2] - 1]) {
			const turnCard = runouts.cards[2][board * width + runouts.width[0]];
			const ranges = rebuildRanges(tiny, compressed, solution, node, board);
			[0, 1].forEach((p) => {
				const map = compressed.standIns![p];
				const reach = solution.reachAt(node, board, p as 0 | 1);
				const start = solution.spot.players[p].weights;
				const source = parseRange([OOP, IP][p]);
				const holds = (c: number): boolean => COMBO_CARDS[c * 2] === turnCard || COMBO_CARDS[c * 2 + 1] === turnCard;
				// One scale for the range, read off a kept combination that lives through the turn.
				const anchor = live([compressed.oop, compressed.ip][p]).find((c) => !holds(c) && reach[c] / start[c] > 0.005)!;
				const scale = ranges[p][anchor] / (source[anchor] * (reach[anchor] / start[anchor]));
				for (const c of held([OOP, IP][p])) {
					const first = [...map.subarray(c * STAND_INS, (c + 1) * STAND_INS)].find((x) => x >= 0 && !holds(x));
					if (first !== map[c * STAND_INS]) passedOver++;
					const share = first === undefined ? 0.005 : Math.max(0.005, Math.min(1, reach[first] / start[first]));
					expect(ranges[p][c]).toBeCloseTo(source[c] * share * scale, 9);
				}
			});
		}
		// The case is met, not only allowed for.
		expect(passedOver).toBeGreaterThan(0);
	});

	it('gives resolveSubgame its ranges, which measure refuses', () => {
		const node = opening(1);
		const ranges = rebuildRanges(tiny, compressed, solution, node, 0);
		const turnCard = runouts.cards[1][runouts.width[0]];
		const turn = resolveSubgame(solution, node, 0, { player: 1, iterations: 5, ranges });
		[0, 1].forEach((p) => {
			const want = live(ranges[p]).filter((c) => COMBO_CARDS[c * 2] !== turnCard && COMBO_CARDS[c * 2 + 1] !== turnCard);
			expect([...turn.solution.spot.players[p].combos].sort((a, b) => a - b)).toEqual(want);
		});
		expect(() => resolveSubgame(solution, node, 0, { player: 1, iterations: 5, ranges, measure: true })).toThrow(/measure/);
	});

	it('refuses ranges compressed without stand-ins, and a solve of other ranges', () => {
		const node = opening(1);
		expect(() => rebuildRanges(tiny, compressRanges(tiny, { tolerance: 0.03 }), solution, node, 0)).toThrow(/standIns: true/);
		expect(() => rebuildRanges(tiny, compressRanges(tiny, { tolerance: 0.01, standIns: true }), solution, node, 0)).toThrow(/not a solve of these/);
	});
});

describe('LiteSolution.resolve on a compressed blueprint', () => {
	const tiny: SpotConfig = { ...spot, pot: 60, stack: 60, betSizes: [[1]], maxRaises: 1 };
	const options = { compressRanges: { tolerance: 0.03 }, iterations: 30, settle: false, sampling: false } as const;

	it('solves the turn for every combination of the caller\'s ranges unless told not to', () => {
		const lite = solveLite(tiny, options);
		const { tree, runouts } = lite.solution.spot;
		const node = [...tree.kind.keys()].find((n) => tree.round[n] === 1 && tree.kind[n] === NodeKind.Decision)!;
		const turnCard = runouts.cards[1][runouts.width[0]];
		const flop = new Set(parseCards(tiny.board));
		const all = live(parseRange(OOP)).filter((c) => [COMBO_CARDS[c * 2], COMBO_CARDS[c * 2 + 1]].every((card) => !flop.has(card) && card !== turnCard));
		const rebuilt = lite.resolve(node, 0, { player: 0, iterations: 10 });
		const keptOnly = lite.resolve(node, 0, { player: 0, iterations: 10, rebuild: false });
		expect([...rebuilt.solution.spot.players[0].combos].sort((a, b) => a - b)).toEqual(all);
		expect(keptOnly.solution.spot.players[0].count).toBeLessThan(all.length);
		// A combination the blueprint left out has a strategy of its own on the turn.
		const left = all.find((c) => lite.solution.spot.players[0].weights[c] === 0)!;
		const view = rebuilt.solution.strategyAt(0, 0);
		const at = [...view.combos].indexOf(left);
		const probs = view.probs.subarray(at * view.actions.length, (at + 1) * view.actions.length);
		expect(probs.reduce((sum, x) => sum + x, 0)).toBeCloseTo(1, 9);
	});

	it('does not rebuild under measure, and refuses rebuild where it cannot apply', () => {
		const lite = solveLite(tiny, options);
		const { tree } = lite.solution.spot;
		const node = [...tree.kind.keys()].find((n) => tree.round[n] === 1 && tree.kind[n] === NodeKind.Decision)!;
		const measured = lite.resolve(node, 0, { player: 0, iterations: 10, measure: true });
		expect(measured.solution.spot.players[0].count).toBeLessThanOrEqual(lite.solution.spot.players[0].count);
		expect(measured.entered).not.toBeNull();
		expect(() => lite.resolve(node, 0, { player: 0, iterations: 10, measure: true, rebuild: true })).toThrow(/measure/);
		const plain = solveLite(tiny, { iterations: 10, settle: false, sampling: false });
		expect(() => plain.resolve(node, 0, { player: 0, iterations: 10, rebuild: true })).toThrow(/compressRanges/);
	});

	it('rebuilds from the session\'s ranges as they stand after a change', () => {
		const session = openLite(tiny, options);
		try {
			const narrower = 'AA-66,AKs-ATs,KQs,AKo-AJo';
			const lite = session.setRange(0, narrower);
			const { tree, runouts } = lite.solution.spot;
			const node = [...tree.kind.keys()].find((n) => tree.round[n] === 1 && tree.kind[n] === NodeKind.Decision)!;
			const turnCard = runouts.cards[1][runouts.width[0]];
			const flop = new Set(parseCards(tiny.board));
			const all = live(parseRange(narrower)).filter((c) => [COMBO_CARDS[c * 2], COMBO_CARDS[c * 2 + 1]].every((card) => !flop.has(card) && card !== turnCard));
			const turn = lite.resolve(node, 0, { player: 0, iterations: 5 });
			expect([...turn.solution.spot.players[0].combos].sort((a, b) => a - b)).toEqual(all);
		} finally {
			session.close();
		}
	});
});
