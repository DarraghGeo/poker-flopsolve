/**
 * The presets' change reports (issue #115): `litePreset` / `solveLite` and
 * `largeTree` say what they cut and switched on, so nothing is silent.
 */

import { describe, expect, it } from 'vitest';
import { defineSpot, liteConfig, litePreset, solveLite } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { sizesCut } from '../src/presets.ts';
import { largeTree, wasmStorage } from '../src/wasm-storage.ts';

/** Issue #47's betting on a narrow flop. */
const flop: SpotConfig = {
	board: 'As Kh 7d', pot: 55, stack: 975,
	oop: 'AA,KK,AKs,76s', ip: 'QQ,JJ,AQs,QJs',
	betSizes: [[0.33, 0.75, 1.5]], raiseSizes: [[0.75]], maxRaises: 3, allowAllIn: true,
};

describe('sizesCut', () => {
	it('finds nothing between a config and itself', () => {
		expect(sizesCut(flop, flop)).toEqual([]);
	});

	it('names the sizes thinSizes cuts, IP\'s 0.33 flop bet after a check among them', () => {
		const cuts = sizesCut(flop, { ...flop, thinSizes: true });
		const ipFlopBet = cuts.find((c) => c.street === 'flop' && c.player === 'ip' && c.facing === 'bet');
		expect(ipFlopBet).toEqual({ street: 'flop', player: 'ip', facing: 'bet', sizes: [0.33, 1.5, 'allin'], decisions: 1, of: 1 });
		// OOP's first decision keeps every size.
		expect(cuts.find((c) => c.street === 'flop' && c.player === 'oop' && c.facing === 'bet')).toBeUndefined();
		for (const c of cuts) {
			expect(c.decisions).toBeGreaterThan(0);
			expect(c.decisions).toBeLessThanOrEqual(c.of);
		}
	});

	it('counts a cut decision once, and nothing below a cut action', () => {
		// One raise fewer on the flop: the third aggression goes, and only it.
		const cuts = sizesCut(flop, { ...flop, maxRaises: [2, 3, 3] });
		expect(cuts.map((c) => `${c.street} ${c.player} ${c.facing}`)).toEqual(['flop oop raise', 'flop ip raise']);
		for (const c of cuts) expect(c.sizes).toEqual([0.75, 'allin']);
	});

	it('works on a turn spot, its first round the turn', () => {
		const turn = { ...flop, board: 'As Kh 7d 2c', betSizes: [[0.33, 0.75]] };
		const cuts = sizesCut(turn, { ...turn, betSizes: [[0.33, 0.75], [0.75]] });
		expect(cuts.map((c) => c.street)).toEqual(['river', 'river']);
		expect(cuts.every((c) => c.facing === 'bet' && c.sizes.join() === '0.33')).toBe(true);
	});
});

describe('litePreset', () => {
	it('reports the turn and river simplified, and the approximations switched on', () => {
		const { config, options, changes } = litePreset(flop);
		expect(config).toEqual(liteConfig(flop));
		expect(options).toEqual({ iterations: 2000, settle: {}, approximations: { chanceSampling: {} } });
		expect(changes.roundsSimplified).toEqual(['turn', 'river']);
		const turnBet = changes.sizesCut.find((c) => c.street === 'turn' && c.player === 'oop' && c.facing === 'bet')!;
		expect(turnBet.sizes).toEqual([0.33, 1.5, 'allin']);
		expect(changes.settings.map((s) => s.setting)).toEqual([
			'runoutBuckets', 'shareHistories', 'approximations.chanceSampling', 'settle',
		]);
		expect(changes.notes).toHaveLength(changes.sizesCut.length + 4);
		expect(changes.notes[0]).toMatch(/^turn: OOP loses the bet sizes 0\.33, 1\.5, all-in at \d+ of the \d+ such decisions the preset keeps$/);
	});

	it('reports a flop cap, donk bets and cuts left out, and leaves out what it did not switch on', () => {
		const removeActions = ['check check / bet 18.15'];
		const { changes } = litePreset({ ...flop, removeActions, shareHistories: true }, {
			flopMaxRaises: 2, noDonk: true, sampling: false, settle: false,
		});
		expect(changes.roundsSimplified).toEqual(['flop', 'turn', 'river']);
		const names = changes.settings.map((s) => s.setting);
		expect(names).toEqual(['noDonk', 'runoutBuckets', 'removeActions']);
		expect(changes.settings.find((s) => s.setting === 'removeActions')).toEqual({ setting: 'removeActions', from: removeActions, to: [] });
		expect(changes.notes.some((n) => /removeActions: 1 line/.test(n))).toBe(true);
		expect(changes.notes.some((n) => /^noDonk/.test(n))).toBe(true);
		expect(changes.notes.some((n) => /chanceSampling|settle|shareHistories/.test(n))).toBe(false);
	});

	it('reports a setting by what it does: equivalent spellings are no change, and off reads as off', () => {
		// Unset and false, true and a gap of 1, an equal array: no change.
		const same = litePreset({ ...flop, runoutBuckets: true, noDonk: [false, true, true] }, {
			noDonk: false, runoutBuckets: 1, shareHistories: true, sampling: false, settle: false,
		}).changes;
		expect(same.settings.map((s) => s.setting)).toEqual(['noDonk', 'shareHistories']);
		expect(same.notes.find((n) => n.startsWith('noDonk'))).toBe('noDonk: donk bets allowed on every street');
		const unchanged = litePreset({ ...flop, noDonk: [false, true, true] }, { sampling: false, settle: false }).changes;
		expect(unchanged.settings.map((s) => s.setting)).not.toContain('noDonk');
		expect(litePreset(flop, { noDonk: false }).changes.settings.map((s) => s.setting)).not.toContain('noDonk');
		// Sharing switched off is reported as off, not as sharing.
		const unshared = litePreset({ ...flop, shareHistories: true }, { shareHistories: false }).changes;
		expect(unshared.notes).toContain('shareHistories: off: every line stores its own river');
		expect(unshared.notes.some((n) => /share river storage/.test(n))).toBe(false);
		// A gap of 0 is buckets off: asked of an unbucketed spot, no change; a spot's own wider gap stands.
		expect(litePreset(flop, { runoutBuckets: 0 }).changes.settings.map((s) => s.setting)).not.toContain('runoutBuckets');
		expect(litePreset({ ...flop, runoutBuckets: 6 }).changes.settings.map((s) => s.setting)).not.toContain('runoutBuckets');
		expect(litePreset(flop).changes.notes.find((n) => n.startsWith('runoutBuckets'))).toMatch(/^runoutBuckets: gap 3: /);
	});

	it('describes the sampling it sets as the sampler reads it', () => {
		const notes = (sampling: object): string | undefined =>
			litePreset(flop, { sampling }).changes.notes.find((n) => n.startsWith('approximations.chanceSampling'));
		expect(notes({})).toBe("approximations.chanceSampling: every later round's deals sampled at p 0.35");
		expect(notes({ p: 0.5 })).toMatch(/at p 0\.5$/);
		expect(notes({ every: 2, p: 0.9 })).toMatch(/walked once every 2 iterations/);
	});

	it('gives one note per change', () => {
		for (const { changes } of [litePreset(flop), litePreset({ ...flop, removeActions: ['check check / bet 18.15'] }, { noDonk: true }), largeTree(flop), largeTree({ ...flop, compactStorage: {} })]) {
			expect(changes.notes).toHaveLength(changes.sizesCut.length + changes.settings.length);
		}
	});

	it('is what solveLite solves, and solveLite hands its report back', () => {
		const small: SpotConfig = { ...flop, board: 'As Kh 7d 2c', stack: 100, betSizes: [[0.33, 0.75]], raiseSizes: [[0.75]] };
		const lite = solveLite(small, { workers: 1, iterations: 20, settle: false });
		expect(lite.changes).toEqual(litePreset(small, { workers: 1, iterations: 20, settle: false }).changes);
		expect(lite.blueprint).toEqual(litePreset(small).config);
		expect(lite.solution.iterations).toBe(20);
	});
});

describe('largeTree changes', () => {
	it('reports thinSizes\' cuts, 16-bit storage and sampling', () => {
		const { changes } = largeTree(flop);
		expect(changes.roundsSimplified).toEqual(['flop', 'turn', 'river']);
		expect(changes.sizesCut.find((c) => c.street === 'flop' && c.player === 'ip' && c.facing === 'bet')?.sizes).toEqual([0.33, 1.5, 'allin']);
		expect(changes.settings).toEqual([
			{ setting: 'thinSizes', from: undefined, to: true },
			{ setting: 'precision', from: undefined, to: 'i16' },
			{ setting: 'wasmStorage', from: undefined, to: wasmStorage },
			{ setting: 'approximations.chanceSampling', from: undefined, to: {} },
		]);
	});

	it('reports a compactStorage it drops, and one it sets', () => {
		const dropped = largeTree({ ...flop, compactStorage: { from: 1 } }).changes;
		expect(dropped.settings).toContainEqual({ setting: 'compactStorage', from: { from: 1 }, to: undefined });
		expect(dropped.notes.some((n) => /compactStorage: dropped/.test(n))).toBe(true);
		const compact = largeTree(flop, { storage: 'compact' }).changes;
		expect(compact.settings).toContainEqual({ setting: 'compactStorage', from: undefined, to: {} });
		expect(compact.settings.some((s) => s.setting === 'precision')).toBe(false);
	});

	it('reports the sampling the solve gets, not the sampling it offered', () => {
		const off = largeTree(flop, { options: { approximations: { chanceSampling: undefined } } });
		expect(off.options.approximations?.chanceSampling).toBeUndefined();
		expect(off.changes.settings.map((s) => s.setting)).not.toContain('approximations.chanceSampling');
		expect(off.changes.notes.some((n) => /chanceSampling/.test(n))).toBe(false);
	});

	it('reports nothing it did not change', () => {
		const { changes } = largeTree({ ...flop, thinSizes: true }, { options: { approximations: { chanceSampling: { p: 0.5 } }, precision: 'i16' } });
		// The config came thinned, and the caller chose the precision and sampling.
		expect(changes.sizesCut).toEqual([]);
		expect(changes.settings.map((s) => s.setting)).toEqual(['wasmStorage']);
	});

	it('reports on a tree too big to define, without allocating it', () => {
		const wide: SpotConfig = { ...flop, oop: '22+,A2s+,K2s+,Q2s+,A2o+,K5o+', ip: '22+,A2s+,K2s+,A2o+' };
		expect(() => defineSpot({ ...wide, maxBytes: 2 ** 30 })).toThrow();
		expect(largeTree(wide).changes.sizesCut.length).toBeGreaterThan(0);
	});
});
