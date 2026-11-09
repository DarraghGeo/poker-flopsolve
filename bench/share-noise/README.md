# Why noise moves the `shareHistories` plateau (issue #105)

#103's pair matrix found that on its small turn spot, exact DCFR with
`shareHistories` stops near 5.3% of pot, while sampling deals or 8-bit
stochastic rounding brings it under 1%. These scripts look for why, and
`bench/blueprint-share/measure.ts` (now with `sampling<p>` and `compact`)
checks whether the gain carries to #85's flop blueprint.

| script | what it does |
|---|---|
| `spot.ts` | #103's turn spot: Ah Kd Qc 8s, pot 60, stack 90, `AA,KK,55,44,AKs,KQs` vs `QQ,JJ,33,22,AQs,QJs`, 0.5 and 1 pot, raise 1, `maxRaises: 2`, river shared |
| `probe.ts [spot] [solve]` | exploitability of the average and of the current profile at 100, 300, 1000 and 3000 iterations, JS engine, one thread |
| `local.ts [spot] [solve]` | share of each player's own reach into shared blocks that comes by a history other than each hand's main one, over the first iterations |
| `probes.patch` | throwaway hooks in `src/cfr.ts` for the experiments below (`git apply`, never merged): a salt for sampling's draws, random weights on shared regret updates, uniform play mixed into training, the probe pass `local.ts` reads |

Exploitability is % of pot, of the shared strategy, measured exactly in
the full game, at 3000 iterations unless noted. "Spot 2" is a second turn
spot with wider ranges, Ts 9s 4h 2c,
`AA,KK,TT,99,44,AT,KTs,QJs,J8s,65s` vs
`QQ,JJ,88,77,22,AJs,KQs,QTs,T9s,87s,76s`, the same betting.

## What it is not

- **Not averaging.** The current profile plateaus with the average:
  5.75% against 5.71% (f32). Weighting or restarting the shared sums
  cannot help.
- **Not the order of updates within an iteration.** Playing every shared
  block from regrets frozen at the start of the iteration (Jacobi rather
  than Gauss–Seidel) gives 5.53%.
- **Not regret weighting.** `weighting: 'counterfactual'` gives 4.93%.
  'reach', the default, is the true gradient of the shared strategy's
  value, so its fixed points are where no shared block can do better on
  its own.
- **Not a need for noise throughout.** Noise added late, after 1000
  iterations, for 20 or 100 iterations, changes nothing (5.76%): the poor
  point attracts.

## What it is: the first iterations pick the basin

The shared game is an imperfect-recall game. A shared block plays one
strategy for every history meeting in it, so a player's value against a
fixed opponent is no longer linear in their own strategy, and CFR's
stable points are local. There are many, and DCFR settles on whichever one
its first few iterations lead to:

- After one iteration, regret matching plays nearly pure everywhere. By
  iteration 2, OOP's own reach into every shared river block is zero
  (`local.ts`: "NaN"). Under sampling (p 0.9) it is not. Which history
  each hand trains a shared block from is decided by near-ties here.
- ±1% random weights on shared regret updates **for the first 5
  iterations only**, and plain DCFR after, end at 0.39%. For the first 2,
  2.6%; first 10, 1.9%; first 20, 0.64%; first 50, 1.6%. Each holds for
  3000 iterations.
- Float rounding is enough to switch basins under CFR+: 9.26% at f32,
  4.62% at f64 (JS), 1.77% at f32 in WebAssembly (#103). DCFR happens to be
  stable across precisions on this spot (5.71% / 5.76%).
- Deterministic perturbations, which do not break near-ties at random,
  did not help: fixed per-history weights within ±1% (5.97%), alternating
  ±1% by iteration (5.51%).

So noise does not help by exploring as the solve goes on. It picks a
different basin at the start, and where it lands is a lottery:

| run (spot 1) | exploitability |
|---|---|
| shared, f64 | 5.76 |
| `chanceSampling {p: 0.9}`, 6 seeds | 0.30, 0.44, 0.80, 0.95, 1.56, 1.58 |
| ±0.1% weights on every shared update, 4 runs | 1.24, 1.80, 2.90, 2.90 |
| ±1% / 10% / 30% / 100% weights on every shared update | 1.64 / 1.63 / 1.45 / 0.95 |
| ±1% weights, first 2 / 5 / 10 / 20 / 50 / 300 iterations | 2.60 / 0.39 / 1.95 / 0.64 / 1.60 / 1.46 |

## Deterministic changes are a lottery too

| change | spot 1 | spot 2 |
|---|---|---|
| none (f64) | 5.76 | 0.70 |
| positive regret kept from iteration 1, not 2 | 4.33 | 1.20 |
| uniform play mixed in, `min(0.5, 5/t)` | 1.69 | |
| uniform play mixed in, 0.5 for 10 iterations | 2.72 | |
| uniform play mixed in, 0.2 for 50 iterations | 5.06 | |
| uniform play mixed in, `1/t` | 6.70 | |
| ±1% random weights, first 5 iterations, 3 runs | | 0.65, 0.68, 0.68 |
| `chanceSampling {p: 0.9}`, 3 seeds | | 0.59, 0.72, 0.76 |

On spot 2 the deterministic solve was already in a good basin, and
noise neither helps nor hurts. Mixing uniform play into the first
iterations, the change that follows most directly from the cause, helps
or not with the schedule. None of these is a rule to adopt.

## The flop blueprint

#85's `1size-b3` on As Kh 7d, river shared, f32 on the WebAssembly engine
(`measure.ts rainbow river <it> <approx>`, with `BLUEPRINT_RESOLVES=0`),
judged against #85's unshared reference, solved again to 0.045%. Root
play loss is % of pot at the reference's per-action values; the
reference's own is 0.0089 / 0.0083.

| run | threads | plateau (best) | root play loss, OOP / IP | root EV error mean, OOP / IP |
|---|---|---|---|---|
| shared alone, 400 it (#85) | 4 | 2.65 (2.61) | 0.0145 / 0.0136 | 0.57 / 0.46 |
| + `chanceSampling {p: 0.35}`, 800 it (#85) | 1 | 2.91 (2.89) | 0.0110 / 0.0104 | 0.42 / 0.46 |
| + `chanceSampling {p: 0.9}`, 800 it | 1 | 2.90 (2.69) | 0.0113 / 0.0098 | 0.44 / 0.36 |
| + `compactStorage: {}` (8-bit, stochastic), 400 it | 4 | 2.53 (2.53) | 0.0162 / 0.0106 | 0.56 / 0.48 |

Neither lowers the plateau: the spread, 2.5–2.9%, is what one more
draw of the lottery gives. Sampling's root play is a little closer, as
#85 found at p 0.35, because it ran twice the iterations. That
iterations-for-time trade is #100's to judge, not this issue's.
`../blueprint-share/out/rainbow-river-{sampling0.9,compact}.*` hold
the output. The compact run stores 71 MiB, not 173; its log's first line
says 173 MiB f32 because `measure.ts` printed the 32-bit size until it was
fixed after the run.

## Reading it

- The plateau of a shared solve is set in its first few iterations, by
  which of the shared game's many stable points they lead to. It is not
  a bug, and noise does not help as the solve goes on.
- On #103's turn spot, every noisy run tried ended better than the
  deterministic one, but anywhere from 0.3% to 2.9%. On a second turn
  spot and on the flop blueprint, noise changed nothing that matters.
  So `chanceSampling` or stochastic `compactStorage` is no fix for a
  shared plateau. Choose them for speed or memory, as before.
- No deliberate dither was added: it would be one more draw, not a gain.
  A cause-led deterministic change, mixing uniform play into the first
  iterations, helped or hurt by schedule. What would work in principle
  is a search over basins, e.g. several short solves from different
  seeds, keeping the least exploitable. On spot 1 the two best of the
  six sampling seeds at 300 iterations were the two best at 3000, but
  this costs a short solve per seed and was not built.
