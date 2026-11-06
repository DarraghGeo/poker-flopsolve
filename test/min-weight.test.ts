/**
 * minWeight: dropping lightly weighted combinations from the ranges.
 */

import { describe, expect, it } from 'vitest';
import { defineSpot, solve } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const river: SpotConfig = { board: 'AsKh7d2c9h', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.33, 0.75]], maxRaises: 1 };
// Hands outside the base ranges, so nothing of theirs is overridden.
const light = { oop: `${OOP},72s:0.01,63s:0.04`, ip: `${IP},54s:0.03` };

describe('minWeight', () => {
	it('drops combinations weighted below it from both ranges', () => {
		const full = defineSpot({ ...river, ...light });
		const trimmed = defineSpot({ ...river, ...light, minWeight: 0.05 });
		expect(trimmed.players[0].count).toBeLessThan(full.players[0].count);
		expect(trimmed.players[1].count).toBeLessThan(full.players[1].count);
		expect(trimmed.players[0].count).toBe(defineSpot(river).players[0].count);
		expect(trimmed.players[1].count).toBe(defineSpot(river).players[1].count);
	});

	it('keeps combinations at or above it', () => {
		const kept = defineSpot({ ...river, ...light, minWeight: 0.03 });
		expect(kept.players[1].count).toBe(defineSpot({ ...river, ...light }).players[1].count);
	});

	it('carries into a subgame', () => {
		const solution = solve(defineSpot({ ...river, ...light, minWeight: 0.05 }), { iterations: 10 });
		expect(solution.subgameAt(0, 0).minWeight).toBe(0.05);
	});
});
