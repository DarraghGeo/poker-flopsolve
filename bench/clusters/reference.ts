import { writeFileSync } from 'node:fs';
import { createRun, defineSpot } from '../../src/index.ts';
import { SPOTS } from './spots.ts';
import { comboEvs } from './metrics.ts';
const OUT = 'bench/clusters/out';
for (const name of (process.argv[2] ?? Object.keys(SPOTS).join(',')).split(',')) {
  const spot = defineSpot(SPOTS[name]);
  const run = createRun(spot, { workers: 4 });
  const t0 = performance.now(); let it = 0; let e = Infinity;
  while (e > 0.025) { run.step(20); it += 20; e = run.exploitabilityPercent(); }
  const ev = comboEvs(run);
  writeFileSync(`${OUT}/ref-${name}.json`, JSON.stringify({ iterations: it, exploitability: e, ev: ev.map((a) => Array.from(a, (x) => (Number.isNaN(x) ? null : x))) }));
  console.log(name, 'combos', spot.estimate.combos, 'runouts', spot.estimate.runouts, 'iters', it, 'expl', e.toFixed(4), 'secs', ((performance.now() - t0) / 1000).toFixed(1), 'EV', run.snapshot().ev(0).toFixed(3), run.snapshot().ev(1).toFixed(3));
  run.close();
}
