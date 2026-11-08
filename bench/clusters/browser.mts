import { createRun, defineSpot } from '../../src/index.ts';
import { runInBrowser } from '../../scripts/browser-harness.ts';
import { SPOTS } from './spots.ts';
const CASES: [string, Record<string, unknown>, string | undefined][] = [];
for (const name of Object.keys(SPOTS)) {
  CASES.push([name, {}, undefined], [name, {}, 'js'], [name, { runoutClusters: { turn: 12 } }, undefined]);
}
const MEASURE = `
function measure(createRun, defineSpot, config, engine) {
  const run = createRun(defineSpot(config), { workers: 1, engine });
  run.step(2);
  const t = performance.now(); run.step(4);
  const ms = (performance.now() - t) / 4; const e = run.engine; run.close(); return { ms, engine: e };
}`;
const configs = CASES.map(([n, extra, engine]) => [n, { ...SPOTS[n], ...extra }, engine]);
const browser = await runInBrowser<{ ms: number; engine: string }[]>(`
  import { createRun, defineSpot } from './src/index.ts';
  ${MEASURE}
  const CASES = ${JSON.stringify(configs)};
  export default async function run() { return CASES.map(([n, c, e]) => measure(createRun, defineSpot, c, e ?? undefined)); }
`, 1_800_000);
const measure = new Function(`${MEASURE}; return measure;`)();
for (let i = 0; i < CASES.length; i++) {
  const [n, extra, engine] = CASES[i];
  const node = measure(createRun, defineSpot, configs[i][1], engine);
  console.log(JSON.stringify({ spot: n, extra, engine: browser[i].engine, browserMs: browser[i].ms, nodeMs: node.ms }));
}
