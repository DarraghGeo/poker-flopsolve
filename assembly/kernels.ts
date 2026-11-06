/**
 * WebAssembly SIMD kernels for the solver's hottest loops.
 *
 * Purpose: what the JIT cannot do on its own — two doubles per instruction.
 * Built by `npm run build:wasm` into `src/wasm/kernels.ts`, which embeds the
 * binary so nothing has to be fetched or bundled at run time.
 *
 * Every kernel does exactly the arithmetic its JavaScript twin in
 * `src/cfr.ts` does, in the same order, so results are bit-identical; the
 * tests hold them to that.
 */

/**
 * Regret matching over one block: each hand's share of the positive regrets,
 * uniform where it has none.
 *
 * Rows are actions, `count` storage slots each, as the solver stores them.
 *
 * @param regret `actions * count` doubles
 * @param out `actions * count` doubles, the strategy, in the same layout
 * @param total `count` doubles of scratch
 */
export function regretMatch(regret: usize, out: usize, total: usize, actions: i32, count: i32): void {
  const zero = f64x2.splat(0.0);
  const n = count & ~1;
  for (let i = 0; i < count; i++) store<f64>(total + (<usize>i << 3), 0.0);
  for (let a = 0; a < actions; a++) {
    const row = <usize>(a * count) << 3;
    let i = 0;
    for (; i < n; i += 2) {
      const at = row + (<usize>i << 3);
      const p = f64x2.max(v128.load(regret + at), zero);
      v128.store(out + at, p);
      const t = total + (<usize>i << 3);
      v128.store(t, f64x2.add(v128.load(t), p));
    }
    for (; i < count; i++) {
      const v = load<f64>(regret + row + (<usize>i << 3));
      const p = v > 0 ? v : 0.0;
      store<f64>(out + row + (<usize>i << 3), p);
      store<f64>(total + (<usize>i << 3), load<f64>(total + (<usize>i << 3)) + p);
    }
  }
  const uniform = f64x2.splat(1.0 / <f64>actions);
  for (let a = 0; a < actions; a++) {
    const row = <usize>(a * count) << 3;
    let i = 0;
    for (; i < n; i += 2) {
      const at = out + row + (<usize>i << 3);
      const t = v128.load(total + (<usize>i << 3));
      const has = f64x2.gt(t, zero);
      v128.store(at, v128.bitselect(f64x2.div(v128.load(at), t), uniform, has));
    }
    for (; i < count; i++) {
      const at = out + row + (<usize>i << 3);
      const t = load<f64>(total + (<usize>i << 3));
      store<f64>(at, t > 0 ? load<f64>(at) / t : 1.0 / <f64>actions);
    }
  }
}

/**
 * The average strategy over one block: each hand's share of its strategy
 * sums; where those are all zero, its share of positive regret; uniform where
 * that is zero too, or where there are no regrets (`hasRegret` 0).
 *
 * @param sums `actions * count` doubles of strategy sums
 * @param regret `actions * count` doubles of regrets, or anything if `hasRegret` is 0
 * @param out `actions * count` doubles, the strategy
 * @param total `2 * count` doubles of scratch
 */
export function averageMatch(sums: usize, regret: usize, out: usize, total: usize, actions: i32, count: i32, hasRegret: i32): void {
  const zero = f64x2.splat(0.0);
  const n = count & ~1;
  const totalRegret = total + (<usize>count << 3);
  for (let i = 0; i < count; i++) {
    store<f64>(total + (<usize>i << 3), 0.0);
    store<f64>(totalRegret + (<usize>i << 3), 0.0);
  }
  // Totals of the sums, and of positive regret, accumulated action by action
  // as the scalar code does.
  for (let a = 0; a < actions; a++) {
    const row = <usize>(a * count) << 3;
    let i = 0;
    for (; i < n; i += 2) {
      const t = total + (<usize>i << 3);
      v128.store(t, f64x2.add(v128.load(t), v128.load(sums + row + (<usize>i << 3))));
      if (hasRegret) {
        const r = totalRegret + (<usize>i << 3);
        v128.store(r, f64x2.add(v128.load(r), f64x2.max(v128.load(regret + row + (<usize>i << 3)), zero)));
      }
    }
    for (; i < count; i++) {
      const t = total + (<usize>i << 3);
      store<f64>(t, load<f64>(t) + load<f64>(sums + row + (<usize>i << 3)));
      if (hasRegret) {
        const r = totalRegret + (<usize>i << 3);
        const v = load<f64>(regret + row + (<usize>i << 3));
        store<f64>(r, load<f64>(r) + (v > 0 ? v : 0.0));
      }
    }
  }
  const uniform = f64x2.splat(1.0 / <f64>actions);
  for (let a = 0; a < actions; a++) {
    const row = <usize>(a * count) << 3;
    let i = 0;
    for (; i < n; i += 2) {
      const t = v128.load(total + (<usize>i << 3));
      const byRegret = hasRegret
        ? v128.bitselect(
            f64x2.div(f64x2.max(v128.load(regret + row + (<usize>i << 3)), zero), v128.load(totalRegret + (<usize>i << 3))),
            uniform,
            f64x2.gt(v128.load(totalRegret + (<usize>i << 3)), zero),
          )
        : uniform;
      const bySum = f64x2.div(v128.load(sums + row + (<usize>i << 3)), t);
      v128.store(out + row + (<usize>i << 3), v128.bitselect(bySum, byRegret, f64x2.gt(t, zero)));
    }
    for (; i < count; i++) {
      const t = load<f64>(total + (<usize>i << 3));
      let value: f64;
      if (t > 0) value = load<f64>(sums + row + (<usize>i << 3)) / t;
      else if (hasRegret && load<f64>(totalRegret + (<usize>i << 3)) > 0) {
        const v = load<f64>(regret + row + (<usize>i << 3));
        value = (v > 0 ? v : 0.0) / load<f64>(totalRegret + (<usize>i << 3));
      } else value = 1.0 / <f64>actions;
      store<f64>(out + row + (<usize>i << 3), value);
    }
  }
}
