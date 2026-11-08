/**
 * The WebGPU showdown prototype (bench/gpu, issue #39), checked without a GPU.
 *
 * The kernel replaces the engine's two sequential sweeps with prefix sums and
 * binary searches. Here that reformulation, in double precision, must give
 * the engine's values on real final-round lists, packed ones included. The
 * WGSL itself is checked against the CPU in a browser by
 * `gpu-showdown.browser.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DECK } from '../src/cards.ts';
import { createRun, defineSpot } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { showdownValuesHands, showdownValuesPacked } from '../src/hands.ts';
import { MAX_CARD_LIST, MAX_LIST, buildShowdownTables, listMatchBlocks, listShowdownJobs, showdownByPrefix } from '../bench/gpu/layout.ts';
import type { PreparedSpot } from '../bench/gpu/layout.ts';
import { ARCHETYPES, rng } from '../bench/leaf/lib.ts';

const OOP = ARCHETYPES.benchOop;
const IP = ARCHETYPES.benchIp;

/** A rainbow turn (no symmetry: plain lists) and a monotone flop (packed lists). */
const SPOTS: Record<string, SpotConfig> = {
	'rainbow turn': { board: 'AsKh7d2c', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.66]], maxRaises: 1 },
	'monotone flop': { board: 'Ks9s4s', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.66]], maxRaises: 1 },
};

function prepare(config: SpotConfig): PreparedSpot {
	const run = createRun(defineSpot(config), { engine: 'js' });
	const ctx = run.solver.ctx;
	run.close();
	return ctx;
}

/** Deterministic reach, a third of it zero, as late in a solve. */
function reachFor(count: number, seed: number): Float64Array {
	const next = rng(seed);
	return Float64Array.from({ length: count }, () => {
		const u = next();
		return u < 0.33 ? 0 : u;
	});
}

/** The text of a top-level function in an AssemblyScript file. */
function functionText(source: string, name: string): string {
	const start = source.search(new RegExp(`^(@inline )?function ${name}\\(`, 'm'));
	if (start < 0) throw new Error(`no function ${name}`);
	const end = source.indexOf('\n}\n', start);
	return source.slice(start, end + 2);
}

describe('bench copy of the engine kernels', () => {
	it('matches assembly/engine.ts', () => {
		const engine = readFileSync(new URL('../assembly/engine.ts', import.meta.url), 'utf8');
		const copy = readFileSync(new URL('../assembly/bench-showdown.ts', import.meta.url), 'utf8');
		for (const name of ['matchRegret', 'normaliseRows', 'showdown', 'addMembers', 'showdownPacked']) {
			expect(functionText(copy, name), name).toBe(functionText(engine, name));
		}
	});
});

describe.each(Object.entries(SPOTS))('GPU showdown layout: %s', (_, config) => {
	const spot = prepare(config);
	const tables = buildShowdownTables(spot);

	it('fits the kernel', () => {
		expect(tables.maxList).toBeLessThanOrEqual(MAX_LIST);
		expect(tables.maxCardList).toBeLessThanOrEqual(MAX_CARD_LIST);
	});

	it('lists one job per river showdown node per river board', () => {
		const jobs = listShowdownJobs(spot, 0);
		const boards = spot.runouts.counts[spot.runouts.rounds - 1];
		expect(jobs.length % boards).toBe(0);
		expect(jobs.length).toBeGreaterThan(0);
		expect(listMatchBlocks(spot).length % boards).toBe(0);
	});

	it.each([0, 1] as const)('matches the engine sweeps for traverser %i', (traverser) => {
		const { active } = spot;
		const jobs = listShowdownJobs(spot, traverser);
		const sums = new Float64Array(DECK);
		let checked = 0;
		let packed = 0;
		for (let index = 0; index < jobs.length; index += 7) {
			const job = jobs[index];
			const reach = reachFor(job.oppCount, index + 17 * traverser);
			const expected = new Float64Array(job.myCount);
			const got = new Float64Array(job.myCount);
			if (job.packed) {
				packed++;
				showdownValuesPacked(
					reach, active.cardA, active.cardB, active.memberStart, active.memberA, active.memberB, active.strength,
					job.oppFrom, job.oppCount, job.myFrom, job.myCount, job.scale, sums, expected,
				);
			} else {
				showdownValuesHands(
					reach, active.cardA, active.cardB, active.strength, job.oppFrom, job.oppCount, job.myFrom, job.myCount,
					job.scale, sums, expected,
				);
			}
			showdownByPrefix(tables, job, reach, got);
			let mass = 0;
			for (let j = 0; j < job.oppCount; j++) mass += reach[j] * tables.members[job.oppFrom + j];
			const tolerance = 1e-12 * Math.abs(job.scale) * (mass + 1);
			for (let i = 0; i < job.myCount; i++) {
				if (Math.abs(got[i] - expected[i]) > tolerance) {
					expect.fail(`job ${index} (node ${job.node}, board ${job.board}) hand ${i}: ${got[i]} vs ${expected[i]}`);
				}
			}
			checked++;
		}
		expect(checked).toBeGreaterThan(10);
		if (config.board === 'Ks9s4s') expect(packed).toBeGreaterThan(0);
	});
});
