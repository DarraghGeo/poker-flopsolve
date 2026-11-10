import { describe, expect, it } from 'vitest';
import {
	checkGap,
	estimateIterationsTo,
	formatBytes,
	formatMs,
	milestones,
	progressToward,
} from '../site/lib/bench.ts';
import type { Check } from '../site/lib/bench.ts';
import { autoMemory, configOf, DEFAULT_SETTINGS, memoryOf, normaliseBoard, readSettings, writeSettings } from '../site/lib/settings.ts';
import { liteSummary } from '../site/lib/lite.ts';
import { litePreset } from '../src/index.ts';
import { defineSpot } from '../src/index.ts';

describe('site benchmark arithmetic', () => {
	it('measures often at first, then every 15% or so', () => {
		expect(checkGap(0)).toBe(1);
		expect(checkGap(5)).toBe(1);
		expect(checkGap(20)).toBe(3);
		expect(checkGap(200)).toBe(30);
	});

	it('moves progress on a log scale from the first measure to the target', () => {
		expect(progressToward(10, 10, 0.1)).toBe(0);
		expect(progressToward(10, 1, 0.1)).toBeCloseTo(0.5);
		expect(progressToward(10, 0.05, 0.1)).toBe(1);
		expect(progressToward(10, 20, 0.1)).toBe(0);
	});

	it('extrapolates the iterations to a target from the last two measures', () => {
		// e = 100 / iterations: 1% at 100.
		const checks: Check[] = [
			{ iterations: 10, exploitability: 10, ms: 100 },
			{ iterations: 20, exploitability: 5, ms: 200 },
		];
		expect(estimateIterationsTo(checks, 1)).toBeCloseTo(100);
		expect(estimateIterationsTo(checks.slice(0, 1), 1)).toBeNull();
		expect(estimateIterationsTo([checks[0], { iterations: 20, exploitability: 12, ms: 1 }], 1)).toBeNull();
		expect(estimateIterationsTo(checks, 6)).toBe(20);
	});

	it('finds when each level was first reached', () => {
		const checks: Check[] = [
			{ iterations: 1, exploitability: 30, ms: 5 },
			{ iterations: 4, exploitability: 4, ms: 20 },
			{ iterations: 9, exploitability: 0.8, ms: 45 },
		];
		expect(milestones(checks, [5, 1, 0.5])).toEqual([
			{ level: 5, iterations: 4, ms: 20 },
			{ level: 1, iterations: 9, ms: 45 },
			{ level: 0.5, iterations: null, ms: null },
		]);
	});

	it('formats times and sizes', () => {
		expect(formatMs(0.42)).toBe('0.42 ms');
		expect(formatMs(12.3)).toBe('12.3 ms');
		expect(formatMs(950)).toBe('950 ms');
		expect(formatMs(12_345)).toBe('12.3 s');
		expect(formatMs(125_000)).toBe('2m 05s');
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(3 * 2 ** 20)).toBe('3.0 MB');
		expect(formatBytes(1.5 * 2 ** 30)).toBe('1.50 GB');
	});
});

describe('site settings', () => {
	it('builds a spot the solver accepts', () => {
		const config = configOf({ ...DEFAULT_SETTINGS, board: 'Ks 9d 4c 2h 7s' });
		expect(config.board).toBe('Ks 9d 4c 2h 7s');
		expect(config.betSizes).toEqual([[0.66]]);
		expect(config.maxRaises).toBe(1);
		expect(defineSpot(config).estimate.rounds).toBe(1);
	});

	it('adds a raise and all-in when asked', () => {
		const config = configOf({ ...DEFAULT_SETTINGS, sizes: 'two', raise: true, allIn: true });
		expect(config.betSizes).toEqual([[0.33, 0.75]]);
		expect(config.maxRaises).toBe(2);
		expect(config.allowAllIn).toBe(true);
	});

	it('round-trips settings through a link, ignoring nonsense', () => {
		const settings = { ...DEFAULT_SETTINGS, board: 'As Kh 7d 2c', oop: 'AA,KK:0.5', pot: 80, threads: 2, target: 0.3, mode: 'lite' as const, memory: 1024 };
		expect(readSettings(writeSettings(settings))).toEqual(settings);
		expect(readSettings('pot=-5&threads=abc&sizes=nope&target=7&board=zz&mode=fast&memory=3000')).toEqual(DEFAULT_SETTINGS);
		expect(readSettings('')).toEqual(DEFAULT_SETTINGS);
	});

	it('normalises boards and refuses bad ones', () => {
		expect(normaliseBoard('asKH7d')).toBe('As Kh 7d');
		expect(normaliseBoard('As As 7d')).toBeNull();
		expect(normaliseBoard('As Kh')).toBeNull();
	});

	it('picks a memory cap for the device', () => {
		expect(autoMemory({ deviceMemory: 8, mobile: false })).toBe(2048);
		expect(autoMemory({ deviceMemory: 4, mobile: false })).toBe(1024);
		expect(autoMemory({ deviceMemory: undefined, mobile: false })).toBe(1024);
		expect(autoMemory({ deviceMemory: 2, mobile: false })).toBe(512);
		expect(autoMemory({ deviceMemory: 8, mobile: true })).toBe(512);
		expect(memoryOf({ ...DEFAULT_SETTINGS, memory: 0 }, 2048)).toBe(2048);
		expect(memoryOf({ ...DEFAULT_SETTINGS, memory: 512 }, 2048)).toBe(512);
		expect(configOf({ ...DEFAULT_SETTINGS, memory: 1024 }, 2048).maxBytes).toBe(2 ** 30);
	});
});

describe('site lite summary', () => {
	it('says in plain words what Lite simplified', () => {
		const config = configOf({ ...DEFAULT_SETTINGS, sizes: 'two', raise: true }, 2048);
		const lines = liteSummary(config, litePreset(config).changes);
		expect(lines[0]).toBe('Turn and river: one bet size (75% pot), no raises.');
		expect(lines).toContain('Similar turn and river cards are solved together.');
		expect(lines.join(' ')).not.toMatch(/shareHistories|runoutBuckets|chanceSampling/);
	});

	it('says when there is nothing to simplify', () => {
		const config = configOf({ ...DEFAULT_SETTINGS, board: 'Ks 9d 4c 2h 7s' }, 2048);
		expect(liteSummary(config, litePreset(config).changes)[0]).toBe('River only: Lite changes almost nothing here, so Exact is the better test.');
	});
});
