import { COMBO_CARDS, COMBOS } from '../../src/cards.ts';
import type { SolveRun } from '../../src/index.ts';

/** Per-combination root EV (chips, = % of pot at pot 100) for both players, NaN where not held. */
export function comboEvs(run: SolveRun): [Float64Array, Float64Array] {
  const { solver } = run;
  const ctx = solver.ctx;
  const out: [Float64Array, Float64Array] = [new Float64Array(COMBOS).fill(NaN), new Float64Array(COMBOS).fill(NaN)];
  const pot = run.spot.potUnits / run.spot.chipScale;
  for (const p of [0, 1] as const) {
    const me = ctx.players[p].weights, opp = ctx.players[1 - p].weights;
    const values = solver.valuesAt(0, 0, p, me, opp, solver.rootLive, solver.rootCount);
    // Opponent mass compatible with each hand.
    const byCard = new Float64Array(52); let total = 0;
    for (let h = 0; h < COMBOS; h++) { const w = opp[h]; if (!w) continue; total += w; byCard[COMBO_CARDS[h*2]] += w; byCard[COMBO_CARDS[h*2+1]] += w; }
    for (let h = 0; h < COMBOS; h++) {
      if (!me[h]) continue;
      const a = COMBO_CARDS[h*2], b = COMBO_CARDS[h*2+1];
      const compat = total - byCard[a] - byCard[b] + opp[h];
      out[p][h] = (100 * values[h]) / (compat * ctx.runoutWeight[0]) / pot;
    }
  }
  return out;
}

export interface Errors { mae: [number, number]; max: [number, number]; range: [number, number]; }

export function errors(ev: [Float64Array, Float64Array], ref: [Float64Array, Float64Array], weights: [Float64Array, Float64Array]): Errors {
  const mae: [number, number] = [0, 0], max: [number, number] = [0, 0], range: [number, number] = [0, 0];
  for (const p of [0, 1]) {
    let sw = 0, se = 0, a = 0, b = 0, wsum = 0;
    for (let h = 0; h < COMBOS; h++) {
      const w = weights[p][h];
      if (!w || Number.isNaN(ref[p][h])) continue;
      const e = Math.abs(ev[p][h] - ref[p][h]);
      sw += w; se += w * e;
      if (w >= 0.01) max[p] = Math.max(max[p], e);
      a += w * ev[p][h]; b += w * ref[p][h]; wsum += w;
    }
    mae[p] = se / sw; range[p] = Math.abs(a - b) / wsum;
  }
  return { mae, max, range };
}
