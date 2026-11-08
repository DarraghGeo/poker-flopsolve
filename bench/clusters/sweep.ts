import { appendFileSync, readFileSync } from 'node:fs';
import { createRun, defineSpot } from '../../src/index.ts';
import type { SpotConfig } from '../../src/index.ts';
import { warmStart } from '../../src/warm.ts';
import { SPOTS } from './spots.ts';
import { comboEvs, errors } from './metrics.ts';
const OUT = 'bench/clusters/out';
const CHECKS = [10, 15, 20, 30, 45, 70, 100, 150, 220];
const LIMIT = Number(process.env.LIMIT ?? 32); // wasm-equivalent seconds
const CONFIGS: Record<string, Partial<SpotConfig>> = {
  exact: {}, gap1: { runoutBuckets: 1 }, gap3: { runoutBuckets: 3 },
  t4: { runoutClusters: { turn: 4 } }, t8: { runoutClusters: { turn: 8 } }, t12: { runoutClusters: { turn: 12 } }, t16: { runoutClusters: { turn: 16 } },
  't8r10': { runoutClusters: { turn: 8, river: 10 } }, 't12r10': { runoutClusters: { turn: 12, river: 10 } }, 't16r20': { runoutClusters: { turn: 16, river: 20 } },
  t16id: { runoutClusters: { turn: 16, hands: 'identity' } }, t12id: { runoutClusters: { turn: 12, hands: 'identity' } },
  't16r20id': { runoutClusters: { turn: 16, river: 20, hands: 'identity' } },
};
const names = (process.argv[2] ?? Object.keys(SPOTS).join(',')).split(',');
const configs = (process.argv[3] ?? Object.keys(CONFIGS).join(',')).split(',');
for (const name of names) {
  const refRaw = JSON.parse(readFileSync(`${OUT}/ref-${name}.json`, 'utf8'));
  const ref = refRaw.ev.map((a: (number | null)[]) => Float64Array.from(a, (x) => (x === null ? NaN : x))) as [Float64Array, Float64Array];
  const realSpot = defineSpot(SPOTS[name]);
  const weights: [Float64Array, Float64Array] = [realSpot.players[0].weights, realSpot.players[1].weights];
  // Engine speed ratio, wasm over js, on the exact game.
  const perIter = (engine?: 'js'): number => {
    const r = createRun(realSpot, { workers: 1, engine }); r.step(2);
    const t = performance.now(); r.step(4); const ms = (performance.now() - t) / 4; r.close(); return ms;
  };
  const wasmMs = perIter(), jsMs = perIter('js');
  const ratio = wasmMs / jsMs;
  appendFileSync(`${OUT}/sweep.jsonl`, JSON.stringify({ spot: name, kind: 'speed', wasmMs, jsMs, ratio }) + '\n');
  console.log(name, 'wasm ms/it', wasmMs.toFixed(0), 'js ms/it', jsMs.toFixed(0), 'ratio', ratio.toFixed(3));
  const real = createRun(realSpot, { workers: 4 });
  for (const config of configs) {
    const t0 = performance.now();
    const spot = defineSpot({ ...SPOTS[name], ...CONFIGS[config] });
    const run = createRun(spot, { workers: 1 });
    const setup = (performance.now() - t0) / 1000;
    const scale = run.engine === 'js' ? ratio : 1;
    let solveSec = 0, it = 0;
    for (const target of CHECKS) {
      const t = performance.now(); run.step(target - it); it = target; solveSec += (performance.now() - t) / 1000;
      const abs = run.exploitabilityPercent();
      warmStart(real.solver.ctx, run.solver.ctx, true);
      const trueExpl = real.exploitabilityPercent();
      const err = errors(comboEvs(real), ref, weights);
      const est = setup + solveSec * scale;
      const row = { spot: name, config, engine: run.engine, runouts: spot.estimate.runouts, turns: spot.runouts.counts[1], iterations: it, setup, solveSec, wasmSec: est, abs, trueExpl, ...err };
      appendFileSync(`${OUT}/sweep.jsonl`, JSON.stringify(row) + '\n');
      console.log(`${name} ${config.padEnd(7)} it ${String(it).padStart(3)} est ${est.toFixed(1).padStart(5)}s true ${trueExpl.toFixed(3)} abs ${abs.toFixed(3)} mae ${err.mae.map((x) => x.toFixed(3))} max ${err.max.map((x) => x.toFixed(2))} range ${err.range.map((x) => x.toFixed(3))}`);
      if (est > LIMIT) break;
    }
    run.close();
  }
  real.close();
}
