/**
 * The presets against napkinpoker's reference solve f03 (issue #115), so a
 * regression in any option they use shows in `npm test`: `litePreset` (what
 * `solveLite` solves) and `largeTree` are solved at their own settings and
 * scored at the stored per-action EVs, as `bench/reference/options.ts` scores
 * them on three spots and more iterations.
 *
 * The fixtures are private (napkinpoker's `tools/bench/flopsolve/reference`,
 * issue #119), so this runs only where `bench/reference/napkinpoker.ts`
 * finds them and skips elsewhere.
 *
 * f03 is a 3-bet pot on a two-tone flop (7c 6s Jc): small enough to solve in
 * seconds, with the stored solve's own root loss 0.069 / 0.061% of pot. Two
 * threads and a fixed iteration count make each solve the same every run, so
 * the bounds sit about a third above what was measured (in the comments) and
 * would catch a preset that played worse.
 */

import { describe, expect, it } from 'vitest';
import { napkinAvailable, napkinSpots } from '../bench/reference/napkinpoker.ts';
import { scoreSolution } from '../bench/reference/score.ts';
import type { SpotScore } from '../bench/reference/score.ts';
import { engineAvailable } from '../src/engine.ts';
import { createRun, defineSpot, litePreset } from '../src/index.ts';
import type { SolveOptions, SpotConfig } from '../src/index.ts';
import { largeTree } from '../src/wasm-storage.ts';

const ITERATIONS = 160;

function scored(config: SpotConfig, options: SolveOptions): SpotScore {
	const { iterations: _cap, settle: _stop, ...rest } = options;
	const run = createRun(defineSpot(config), { ...rest, workers: 2 });
	try {
		run.step(ITERATIONS);
		return scoreSolution(run.snapshot(), 'f03');
	} finally {
		run.close();
	}
}

// The fixtures live in the private napkinpoker repository (#119): without
// them this skips. A skipped suite's body still runs, so f03 loads in the tests.
describe.skipIf(!engineAvailable() || !napkinAvailable())('presets on napkinpoker f03', () => {
	const f03 = (): SpotConfig => napkinSpots().find((s) => s.id === 'f03')!.config;

	it('litePreset: root, flop and turn play near the stored solve', () => {
		const { config, options } = litePreset(f03());
		const score = scored(config, options);
		expect(score.missing).toEqual([]);
		expect(score.root.oop!.loss).toBeLessThan(0.12); // 0.086
		expect(score.root.ip!.loss).toBeLessThan(0.12); // 0.086
		expect(score.flop.loss).toBeLessThan(0.09); // 0.063
		// Its turn has one size, so the stored turn nodes it holds score worse.
		expect(score.turn.loss).toBeLessThan(0.26); // 0.193
	});

	it("largeTree: OOP's root as the stored solve's, IP's after a check paying for its cut 0.33 bet", () => {
		const { config, options } = largeTree(f03());
		const score = scored(config, options);
		// thinSizes leaves stored flop lines out of its tree.
		expect(score.missing.length).toBeGreaterThan(0);
		expect(score.root.oop!.loss).toBeLessThan(0.12); // 0.087
		expect(score.root.ip!.loss).toBeLessThan(0.4); // 0.302
		expect(score.flop.loss).toBeLessThan(0.13); // 0.096
		expect(score.turn.loss).toBeLessThan(0.34); // 0.254
	});
});
