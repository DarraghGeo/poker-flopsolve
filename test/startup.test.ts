/**
 * What a run sets up before its first iteration: the tables kept from one
 * spot and run to the next, and the engine threads lent from run to run.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, releaseSetupCache } from '../src/index.ts';
import type { SolveOptions, SpotConfig } from '../src/index.ts';
import { enableThreads } from '../src/threads.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const turn: SpotConfig = { board: 'AsKh7d2c', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.33, 0.75]], maxRaises: 1 };
const ONE: SolveOptions = { workers: 1 };

/** Exploitability after a few iterations of a spot defined and run from nothing kept. */
function fresh(config: SpotConfig, options: SolveOptions = ONE): number {
	releaseSetupCache();
	return solved(config, options);
}

function solved(config: SpotConfig, options: SolveOptions = ONE): number {
	const run = createRun(defineSpot(config), options);
	try {
		run.step(8);
		return run.exploitabilityPercent();
	} finally {
		run.close();
	}
}

describe('setup tables', () => {
	it('are kept for a spot defined again with other betting, a pot or reweighted ranges', () => {
		releaseSetupCache();
		const first = createRun(defineSpot(turn), ONE);
		const again = createRun(defineSpot({ ...turn, pot: 80, betSizes: [[0.5]], oop: `${OOP},AKo:0.5` }), ONE);
		try {
			expect(again.spot.runouts).toBe(first.spot.runouts);
			expect(again.solver.ctx.active).toBe(first.solver.ctx.active);
			expect(again.solver.ctx.hands).toBe(first.solver.ctx.hands);
			expect(again.solver.ctx.showdown).toBe(first.solver.ctx.showdown);
		} finally {
			first.close();
			again.close();
		}
	});

	it('are built again for other hands, another board or other symmetries', () => {
		releaseSetupCache();
		const first = createRun(defineSpot(turn), ONE);
		const { active } = first.solver.ctx;
		first.close();
		for (const other of [{ ...turn, oop: `${OOP},65s` }, { ...turn, board: 'AsKh7d3c' }, { ...turn, oop: `${OOP},AdKc:0.5` }, { ...turn, isomorphism: false }]) {
			const run = createRun(defineSpot(other), ONE);
			expect(run.solver.ctx.active).not.toBe(active);
			run.close();
		}
	});

	it.each([
		['a pot', { pot: 80 }],
		['other betting', { betSizes: [[0.5, 1]], maxRaises: 2 }],
		['a reweighted range', { oop: `${OOP},AKo:0.5,KQs:0.25` }],
		['runout buckets', { board: 'AsKh7d', betSizes: [[0.66]], runoutBuckets: 3 }],
		['a river', { board: 'AsKh7d2c9h' }],
	] as const)('solve %s on kept tables exactly as on fresh ones', (_, change) => {
		const config = { ...turn, ...change } as SpotConfig;
		const expected = fresh(config);
		// Kept from a neighbouring spot, then from the spot itself.
		releaseSetupCache();
		solved({ ...config, pot: 61 });
		expect(Object.is(solved(config), expected)).toBe(true);
		expect(Object.is(solved(config), expected)).toBe(true);
	});

	it('lists a final board by strength, each orbit once', () => {
		releaseSetupCache();
		const run = createRun(defineSpot({ ...turn, board: 'Ks9s4s', betSizes: [[0.66]] }), ONE);
		try {
			const { active } = run.solver.ctx;
			const { runouts, players } = run.spot;
			const last = runouts.rounds - 1;
			for (let board = 0; board < runouts.counts[last]; board += 7) {
				for (let player = 0; player < 2; player++) {
					const slot = (active.roundBase[last] + board) * 2 + player;
					const seen = new Set<number>();
					for (let e = active.start[slot]; e < active.start[slot] + active.count[slot]; e++) {
						if (e > active.start[slot]) expect(active.strength[e]).toBeGreaterThanOrEqual(active.strength[e - 1]);
						expect(players[player].combos[active.slot[e]]).toBe(active.list[e]);
						expect(active.memberCombo[active.memberStart[e]]).toBe(active.list[e]);
						expect(active.multiplicity[e]).toBe(active.memberStart[e + 1] - active.memberStart[e]);
						for (let m = active.memberStart[e]; m < active.memberStart[e + 1]; m++) {
							expect(seen.has(active.memberCombo[m])).toBe(false);
							seen.add(active.memberCombo[m]);
						}
					}
				}
			}
		} finally {
			run.close();
		}
	});
});

describe('engine threads', () => {
	const flop: SpotConfig = { ...turn, board: 'Ts9s4h', betSizes: [[0.66]] };
	const threaded: SolveOptions = { workers: 3 };

	it('serve one run after another, and two at once', () => {
		const expected = fresh(flop, threaded);
		expect(Object.is(solved(flop, threaded), expected)).toBe(true);
		expect(Object.is(solved(flop, threaded), expected)).toBe(true);
		const a = createRun(defineSpot(flop), threaded);
		const b = createRun(defineSpot(flop), threaded);
		try {
			expect(a.workers).toBe(3);
			expect(b.workers).toBe(3);
			a.step(8);
			b.step(8);
			expect(Object.is(a.exploitabilityPercent(), expected)).toBe(true);
			expect(Object.is(b.exploitabilityPercent(), expected)).toBe(true);
		} finally {
			a.close();
			b.close();
			// Closing twice lends nothing twice.
			a.close();
		}
		expect(Object.is(solved(flop, threaded), expected)).toBe(true);
	});

	it('can be started ahead of a run, and stopped', async () => {
		const expected = fresh(flop, threaded);
		expect(await enableThreads(3)).toBe(3);
		expect(Object.is(solved(flop, threaded), expected)).toBe(true);
		expect(await enableThreads(1)).toBe(1);
		expect(Object.is(solved(flop, threaded), expected)).toBe(true);
	});

	it('map the storage a run starts from, leaving it zeroed', () => {
		for (const options of [ONE, threaded]) {
			const run = createRun(defineSpot(flop), options);
			try {
				expect(run.engine).toBe('wasm');
				expect(run.solver.ctx.regret.every((value) => value === 0)).toBe(true);
				expect(run.solver.ctx.strategySum.every((value) => value === 0)).toBe(true);
			} finally {
				run.close();
			}
		}
	});
});
