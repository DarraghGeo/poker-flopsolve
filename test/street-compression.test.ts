import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, liteConfig, litePreset, solve, solveLite } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { COMBO_CARDS } from '../src/cards.ts';

/**
 * `SpotConfig.streetCompression`: a kept set of hands for every turn and river
 * board, inside one solve. The ranges are wide enough for a board to have
 * something to drop, the betting small enough to solve in a test.
 */
const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KTo,QJo';
const IP = 'AA-22,AKs-A2s,KQs-K8s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AKo-A9o,KQo-KTo,QJo';
const flop: SpotConfig = { board: 'Ts 9s 4h', pot: 55, stack: 975, oop: OOP, ip: IP, betSizes: [[0.66]], maxRaises: 1 };
const turn: SpotConfig = { ...flop, board: 'Ts 9s 4h 2c' };
/** Tolerances too small to drop a hand: every candidate is kept, through the kept sets' own path. */
const WHOLE = { turn: 1e-12, river: 1e-12 };

describe('streetCompression', () => {
	it('is the plain solve when every hand is kept, in either engine', () => {
		for (const engine of ['js', undefined] as const) {
			const options = { iterations: 6, workers: 1, ...(engine ? { engine } : {}) };
			const plain = solve(defineSpot(turn), options);
			const kept = solve(defineSpot({ ...turn, streetCompression: WHOLE }), options);
			expect(kept.spot.kept).toBeDefined();
			expect(kept.spot.estimate.totalSlots).toBe(plain.spot.estimate.totalSlots);
			expect(kept.ev(0)).toBeCloseTo(plain.ev(0), 5);
			expect(kept.exploitabilityPercent()).toBeCloseTo(plain.exploitabilityPercent(), 5);
		}
	});

	it('is the plain solve from a flop when every hand is kept', () => {
		const options = { iterations: 4, workers: 1 };
		const plain = solve(defineSpot(flop), options);
		const kept = solve(defineSpot({ ...flop, streetCompression: WHOLE }), options);
		expect(kept.ev(0)).toBeCloseTo(plain.ev(0), 5);
		expect(kept.exploitabilityPercent()).toBeCloseTo(plain.exploitabilityPercent(), 5);
	});

	it('stores fewer hands on later boards, and keeps the weight that arrives', () => {
		const plain = defineSpot(flop);
		const spot = defineSpot({ ...flop, streetCompression: { turn: 0.01, river: 0.01 } });
		const kept = spot.kept!;
		expect(spot.estimate.totalSlots).toBeLessThan(plain.estimate.totalSlots * 0.6);
		expect(kept.keptHands[1]).toBeLessThan(kept.candidates[1]);
		expect(kept.keptHands[2]).toBeLessThan(kept.candidates[2]);
		// A river board's kept hands weigh, between them, what its candidates did.
		const round = 2;
		let slots = 0;
		for (let round0 = 0; round0 < round; round0++) slots += spot.runouts.counts[round0] * 2;
		for (let board = 0; board < Math.min(40, spot.runouts.counts[round]); board++) {
			for (let player = 0; player < 2; player++) {
				const slot = slots + board * 2 + player;
				let arrived = 0;
				let keptWeight = 0;
				for (let i = kept.start[slot]; i < kept.start[slot + 1]; i++) {
					if (kept.stand[i] === kept.combo[i]) keptWeight += kept.weight[i] * kept.orbit[i];
				}
				// What arrived is what the kept hands gather at a reach of one a hand: scale times the candidates' count.
				const gathered = new Map<number, number>();
				for (let i = kept.start[slot]; i < kept.start[slot + 1]; i++) gathered.set(kept.stand[i], (gathered.get(kept.stand[i]) ?? 0) + kept.orbit[i]);
				for (let i = kept.start[slot]; i < kept.start[slot + 1]; i++) {
					if (kept.stand[i] !== kept.combo[i]) continue;
					expect(kept.scale[i]).toBeGreaterThan(0);
					arrived += gathered.get(kept.combo[i])! > 0 ? kept.weight[i] * kept.orbit[i] : 0;
				}
				expect(arrived).toBeCloseTo(keptWeight, 6);
			}
		}
	});

	it('solves close to the full game, and a tighter tolerance closer', () => {
		const measure = (streets: SpotConfig['streetCompression']): number => {
			const run = createRun(defineSpot({ ...turn, streetCompression: streets }), { workers: 1 });
			run.step(60);
			const percent = run.trueExploitabilityPercent();
			run.close();
			return percent;
		};
		const loose = measure({ river: 0.04 });
		const tight = measure({ river: 0.005 });
		// The figure is the kept sets' cost on top of 60 passes' own: a few points of pot at the tight end.
		expect(tight).toBeLessThan(loose);
		expect(tight).toBeLessThan(5);
	});

	it('gives the same answer on any number of threads', () => {
		const config = { ...turn, streetCompression: { river: 0.01 } };
		const one = solve(defineSpot(config), { iterations: 8, workers: 1 });
		const two = solve(defineSpot(config), { iterations: 8, workers: 2 });
		expect(two.ev(0)).toBeCloseTo(one.ev(0), 4);
		const pooled = solve(defineSpot(config), { iterations: 8, workers: 2, engine: 'js' });
		const alone = solve(defineSpot(config), { iterations: 8, workers: 1, engine: 'js' });
		expect(pooled.ev(0)).toBeCloseTo(alone.ev(0), 8);
	});

	it('reads a hand that is not kept as its stand-in', () => {
		const spot = defineSpot({ ...turn, streetCompression: { river: 0.02 } });
		const sol = solve(spot, { iterations: 6, workers: 1 });
		const kept = spot.kept!;
		const node = spot.tree.decisionNodes.find((n) => spot.tree.round[n] === 1)!;
		const player = spot.tree.player[node];
		const board = 0;
		const view = sol.strategyAt(node, board);
		const row = new Map<number, number[]>();
		view.combos.forEach((combo, i) => row.set(combo, Array.from(view.probs.subarray(i * view.actions.length, (i + 1) * view.actions.length))));
		const slot = (spot.runouts.counts[0] + board) * 2 + player;
		let dropped = 0;
		for (let i = kept.start[slot]; i < kept.start[slot + 1]; i++) {
			if (kept.stand[i] === kept.combo[i]) continue;
			dropped++;
			expect(row.get(kept.combo[i])).toEqual(row.get(kept.stand[i]));
		}
		expect(dropped).toBeGreaterThan(0);
		// And every hand the board leaves live has a strategy.
		const dealt = spot.runouts.cards[1][spot.runouts.width[1] - 1];
		for (const [combo, probs] of row) {
			if (COMBO_CARDS[combo * 2] === dealt || COMBO_CARDS[combo * 2 + 1] === dealt) continue;
			expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
		}
	});

	it('reweighs its hands in place, and takes a new hand on a new run', () => {
		const run = createRun(defineSpot({ ...turn, streetCompression: { river: 0.01 } }), { workers: 1 });
		run.step(4);
		const before = run.spot;
		// Hands the range held, at other weights: the kept sets stand as they are.
		run.setRange(0, 'AA-22,AKs-ATs:0.5,KQs,AKo:0.25');
		expect(run.spot).toBe(before);
		run.step(2);
		expect(Number.isFinite(run.exploitabilityPercent())).toBe(true);
		// A hand it did not hold: a new run, with kept sets chosen again.
		run.setRange(0, 'AA-22,AKs-ATs,KQs,AKo,72o');
		expect(run.spot).not.toBe(before);
		expect(run.spot.kept).toBeDefined();
		expect(run.spot.kept).not.toBe(before.kept);
		run.step(2);
		expect(Number.isFinite(run.exploitabilityPercent())).toBe(true);
		run.close();
	});

	it('refuses tolerances that are none, and runout buckets under a compressed turn', () => {
		expect(() => defineSpot({ ...flop, streetCompression: { turn: 1.5 } })).toThrow(/streetCompression\.turn/);
		expect(() => defineSpot({ ...flop, streetCompression: { river: -0.1 } })).toThrow(/streetCompression\.river/);
		expect(() => defineSpot({ ...flop, runoutBuckets: 3, streetCompression: { turn: 0.01 } })).toThrow(/runoutBuckets/);
		expect(defineSpot({ ...flop, runoutBuckets: 3, streetCompression: { river: 0.01 } }).kept).toBeDefined();
		expect(defineSpot({ ...flop, streetCompression: {} }).kept).toBeUndefined();
	});

	it('is a Lite option, with a threshold a street', () => {
		const lite = liteConfig(flop, { streetCompression: { turn: 0.01, river: 0.02 } });
		expect(lite.streetCompression).toEqual({ turn: 0.01, river: 0.02 });
		expect(lite.runoutBuckets).toBe(false);
		expect(liteConfig(flop, { streetCompression: { river: 0.02 } }).runoutBuckets).toBe(3);
		const preset = litePreset(flop, { streetCompression: { river: 0.02 } });
		expect(preset.changes.settings.some((change) => change.setting === 'streetCompression')).toBe(true);
		const solved = solveLite(turn, { streetCompression: { river: 0.02 }, compressRanges: { tolerance: 0.02 }, iterations: 6, settle: false, workers: 1 });
		expect(solved.solution.spot.kept).toBeDefined();
		expect(Number.isFinite(solved.solution.ev(0))).toBe(true);
	});
});
