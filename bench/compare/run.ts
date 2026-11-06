/**
 * poker-flopsolve against b-inary/postflop-solver.
 *
 * Purpose: the yardstick for speed work — the same spots, trees, storage
 * precision (32-bit), thread count and measurement on both sides, printed side
 * by side.
 *
 *   npm run bench:compare                      # 1 and 4 threads, every spot
 *   npm run bench:compare -- --threads 4 --spots turn,flop
 *
 * Both check exploitability on the same 15% geometric schedule and time only
 * the solving, as `bin/bench.ts` does. postflop-solver is built from
 * rust/ with cargo (fetched at build time, never vendored: it is AGPL), at
 * native CPU features, its best case. Needs a Rust toolchain.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRun, defineSpot } from '../../src/index.ts';
import { SPOTS } from './spots.ts';

interface Result {
	spot: string;
	mb: number;
	msPerIteration: number;
	checkMs: number;
	to1: [number, number] | null;
	to03: [number, number] | null;
	exploitability: number;
}

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : fallback;
};
const threadCounts = flag('threads', '1,4').split(',').map(Number);
const names = flag('spots', Object.keys(SPOTS).join(',')).split(',');
const CAP = 1000;
const TARGETS = [1, 0.3];

function ours(name: string, workers: number): Result {
	const spot = defineSpot(SPOTS[name]);
	const run = createRun(spot, { workers, precision: 'f32' });
	try {
		let started = performance.now();
		run.step(2);
		let solving = performance.now() - started;
		started = performance.now();
		run.step(5);
		const block = performance.now() - started;
		solving += block;
		started = performance.now();
		run.exploitabilityPercent();
		const checkMs = performance.now() - started;
		const hit: ([number, number] | null)[] = [null, null];
		let exploitability = Infinity;
		while (run.completed < CAP && !hit[1]) {
			const next = Math.max(run.completed + 1, Math.ceil(run.completed * 1.15));
			started = performance.now();
			run.step(next - run.completed);
			solving += performance.now() - started;
			exploitability = run.exploitabilityPercent();
			TARGETS.forEach((target, k) => {
				if (!hit[k] && exploitability <= target) hit[k] = [run.completed, solving / 1000];
			});
		}
		return {
			spot: name, mb: spot.estimate.bytes / 1048576, msPerIteration: block / 5, checkMs,
			to1: hit[0], to03: hit[1], exploitability,
		};
	} finally {
		run.close();
	}
}

const rustDir = fileURLToPath(new URL('./rust/', import.meta.url));
function theirs(workers: number): Result[] {
	execFileSync('cargo', ['build', '--release', '--quiet'], { cwd: rustDir, stdio: 'inherit' });
	const out = execFileSync(`${rustDir}target/release/pfs-bench`, names, {
		cwd: rustDir,
		env: { ...process.env, RAYON_NUM_THREADS: String(workers) },
		encoding: 'utf8',
	});
	return out.trim().split('\n').map((line) => JSON.parse(line) as Result);
}

const hit = (h: [number, number] | null): string => (h ? `${h[0]} it ${h[1].toFixed(1)} s` : `>${CAP} it`);
for (const workers of threadCounts) {
	const reference = new Map(theirs(workers).map((r) => [r.spot, r]));
	console.log(`\n${workers} thread${workers === 1 ? '' : 's'}   (poker-flopsolve | postflop-solver)`);
	console.log('spot      ms/iter            check ms           to 0.3% of pot                    time ratio');
	for (const name of names) {
		const a = ours(name, workers);
		const b = reference.get(name)!;
		// Under 50 ms a ratio is timer noise.
		const ratio = a.to03 && b.to03 && b.to03[1] >= 0.05 ? (a.to03[1] / b.to03[1]).toFixed(1) + 'x' : '-';
		console.log(
			`${name.padEnd(9)} ${a.msPerIteration.toFixed(1).padStart(7)} | ${b.msPerIteration.toFixed(1).padEnd(7)}` +
				`  ${a.checkMs.toFixed(1).padStart(7)} | ${b.checkMs.toFixed(1).padEnd(7)}` +
				`  ${hit(a.to03).padStart(15)} | ${hit(b.to03).padEnd(15)}  ${ratio}`,
		);
	}
}
