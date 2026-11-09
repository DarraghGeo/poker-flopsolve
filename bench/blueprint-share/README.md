# `shareHistories` on the phone blueprint (issue #85)

Issue #47's blueprint keeps T's flop betting (0.33, 0.75 and 1.5 pot, a 0.75
raise, all-in, three aggressions) and plays one 0.75 bet on the turn and
river with no raise, at `runoutBuckets: 3` (`bench/nested` variant
`1size-b3`). On As Kh 7d it needs 707 MiB at 32 bits. These scripts measure
it with `shareHistories`, which keeps it on the WebAssembly engine.

| script | what it does |
|---|---|
| `census.ts` | storage with and without sharing (river, turn+river) and buckets, on three flops; no solving |
| `measure.ts <board> <none\|river\|turn+river> [cap] [sampling,coarse]` | solves the blueprint in Node on 4 threads at f32, then root EV error, root play loss and turn re-solve gain against a reference |
| `browser.ts <board> <share> [workers] [cap] [sampling,coarse]` | the same blueprint in headless Chromium: time per check and the renderer's peak RSS |

References: on Ks 9s 4s, the full tree T from `bench/nested/reference.ts`.
On As Kh 7d no full tree fits, so the reference is the unshared blueprint
(`measure.ts rainbow none 1500` with `BLUEPRINT_TARGET=0.05`), which also
saves turn subgames at T's betting, solved 600 iterations, for the 3 flop
lines it reaches most and turns 2c, Qs, 7c. Re-solves ('unsafe', 300
iterations, T's betting) are judged by the opponent's best-response gain
under those subgames' ranges, weighted by how often each line is reached.

`out/` holds what they printed. `rainbow-none-0.3.*` is the unshared
blueprint stopped at 0.3% of pot: as a reference its own root play lost
0.074% of pot at its own values, too loose to judge a few hundredths, so the
reference was solved again to 0.045%. `coarse` changed nothing (identical
output): the blueprint's own gap of 3 already folds every runout the ranges
allow, so `coarseStart` finds no coarser copy and does not run.

## Results (As Kh 7d)

Storage (`out/census.md`): sharing the river saves 4.1× on all three flops,
196 river decisions keeping 44 blocks; As Kh 7d at `runoutBuckets: 3` goes
from 707 MiB to 173 MiB at 32 bits.

Accuracy against the unshared blueprint (Node, 4 threads; what sharing
costs, not distance to the full tree):

| run | root play loss, OOP / IP, % pot | root EV error mean (max) | re-solve gain, OOP / IP refined |
|---|---|---|---|
| unshared (the reference's own) | 0.009 / 0.008 | — | 0.67 / 0.50 |
| river, 400 it | 0.015 / 0.014 | 0.57 / 0.46 (2.2 / 2.7) | 3.0 / 2.2 |
| river + sampling, 800 it | 0.011 / 0.010 | 0.42 / 0.46 (2.1 / 3.1) | 2.2 / 2.3 |
| river, 120 it | 0.054 / 0.030 | 1.27 / 1.60 (3.5 / 5.2) | 7.2 / 3.7 |
| turn+river, 400 it | 0.023 / 0.013 | 0.65 / 0.87 (2.8 / 4.5) | 4.3 / 3.9 |

Chromium (`browser-*.log`; solving time only):

| run | threads | ms/it | peak RSS | 0.3% | root still | root loss settled |
|---|---|---|---|---|---|---|
| unshared | 1 | 1490 | 850 MiB | 331 s | 452 s | 481 s |
| unshared | 4 | 450 | 860 MiB | 115 s | 134 s | 151 s |
| river | 4 | 458 | 327 MiB | never (plateau 2.8% at 74 s) | 185 s | 138 s |
| river + sampling | 1 | 238 | 453 MiB | never (plateau 3.2% at 95 s) | 86 s | 109 s |

Against the pass mark: memory passes (327 MiB on the WebAssembly engine);
the settled root play is within a few thousandths of a percent of pot of the
unshared blueprint's; 60 s on 4 threads is not met, by shared or unshared.
Two-tone and monotone have unshared references (`*-none.*`) but were not
timed or scored before the work stopped.

## Recovering turn re-solves (issue #101)

`recover.ts <board> <name> '<json>'` solves a blueprint variant and scores
it against the unshared reference above (`measure.ts <board> none` with
`BLUEPRINT_TARGET=0.05`, rebuilt here; it reproduces #85's figures to the
last digit). It reports what `measure.ts` does, plus the distance of each
player's turn range from the reference's, and re-solves with one player's
range swapped for the reference's. `refine.ts` is the refinement it tries.
`browser.ts` takes `KEEP_TOP`/`KEEP_MIB`, `PICK_PROXY` and `PRECISION=i16`
for the hybrid. Logs and JSON are in `out/recover-*` and
`out/browser-*-{budget,proxy,i16}*`.

Re-solve gain below is the opponent's best response against an unsafe turn
re-solve at T's betting (300 iterations), under the reference's ranges, %
of the subgame pot, weighted by line reach, refining OOP / IP. "Over" is
that minus the unshared blueprint's own re-solves. These scores measure what
sharing costs against the unshared blueprint, not distance to the full
three-size game.

**Diagnosis.** `resolveSubgame` at new betting already starts cold:
`subgameAt` hands over only the ranges. The whole gap is the refined
player's own range at the turn. On rainbow at 400 iterations, re-solving
with the reference's OOP range gives 0.67 against 3.05 for OOP, and with
the reference's IP range 0.54 against 2.15 for IP. The ranges reach the
lines about as often as they should (mass 0.95–1.0); their composition is
off by 0.06–0.09 in total variation.

**What was tried, rainbow, 400 iterations, f32, Node on 4 threads:**

| variant | storage | re-solve gain | over | root EV error, mean | root play loss |
|---|---|---|---|---|---|
| unshared | 707 MiB | 0.67 / 0.50 | | | 0.009 / 0.008 |
| shared | 173 | 3.05 / 2.15 | +2.38 / +1.65 | 0.56 / 0.46 | 0.014 / 0.014 |
| shared, 800 it | 173 | 2.48 / 2.36 | +1.81 / +1.86 | 0.45 / 0.29 | 0.009 / 0.011 |
| `weighting: 'counterfactual'` | 173 | 7.25 / 6.48 | +6.6 / +6.0 | 3.10 / 1.58 | 0.029 / 0.037 |
| refine the opened line 60 it | 201–215 | 2.51 / 1.89 | +1.84 / +1.39 | | 0.013 / 0.013 |
| keep top 1 | 201 | 2.48 / 1.58 | +1.81 / +1.08 | 0.45 / 0.53 | 0.024 / 0.011 |
| keep top 3 | 285 | 1.10 / 0.83 | +0.43 / +0.34 | 0.24 / 0.21 | 0.013 / 0.009 |
| keep top 3, warm from the pick | 285 | 1.66 / 0.89 | +0.99 / +0.39 | 0.30 / 0.25 | 0.012 / 0.009 |
| keep top 6 | 383 | 1.16 / 0.65 | +0.49 / +0.15 | 0.23 / 0.27 | 0.014 / 0.009 |
| keep 150 MiB, i16 (3 lines) | 150 (i16) | 1.47 / 0.92 | +0.80 / +0.42 | 0.32 / 0.29 | 0.015 / 0.010 |
| keep 200 MiB, i16 (6 lines) | 199 (i16) | 1.53 / 0.91 | +0.86 / +0.41 | 0.65 / 0.46 | 0.019 / 0.019 |

Lines were ranked by `turnLineReach` after 80 shared iterations; with
`pickProxy`, after 80 iterations of the blueprint with its river checked
down (57 MiB, 20 s), which picks the same three lines on rainbow.

**Two-tone and monotone, 400 iterations** (references at 0.049% and
0.043%; the unshared root play's own loss there is 0.116 / 0.052 and
0.047 / 0.025):

| board | variant | storage | re-solve gain | over | root EV error, mean |
|---|---|---|---|---|---|
| Ts 9s 4h | unshared | 501 MiB | 0.48 / 0.55 | | |
| | shared | 122 | 4.10 / 3.69 | +3.62 / +3.14 | 0.45 / 0.29 |
| | keep top 3 | 192 | 1.82 / 1.96 | +1.34 / +1.41 | 0.49 / 0.24 |
| | keep 300 MiB (6 lines) | 282 | 0.61 / 0.72 | +0.13 / +0.17 | 0.08 / 0.06 |
| | keep 300 MiB, proxy pick (6) | 272 | 0.91 / 0.79 | +0.43 / +0.25 | 0.18 / 0.16 |
| | keep 150 MiB at i16, proxy pick (6) | 141 (i16) | 0.88 / 0.85 | +0.40 / +0.30 | 0.25 / 0.15 |
| Ks 9s 4s | unshared | 187 MiB | 0.44 / 0.47 | | |
| | shared | 47 | 4.23 / 2.72 | +3.79 / +2.25 | 0.46 / 0.87 |
| | keep top 3 | 76 | 1.16 / 0.60 | +0.72 / +0.14 | 0.16 / 0.27 |
| | keep top 6 | 102 | 0.67 / 0.54 | +0.23 / +0.07 | 0.08 / 0.09 |
| | keep 300 MiB (all 19 lines) | 187 | 0.52 / 0.49 | +0.08 / +0.02 | 0.06 / 0.11 |

A fixed number of lines is not enough on two-tone, where the top 3 hold
less of the play; a storage budget fits all three textures.

**Chromium** (`browser.ts`, 4 threads, 400 iterations, solving time only,
the pick included; peak is the renderer's RSS):

| variant | storage | peak | ms/it | root loss settled (±0.01%) |
|---|---|---|---|---|
| rainbow shared (`browser-rainbow-river-4-rerun.log`) | 173 MiB | 326 MiB | 495 | 136 s |
| rainbow, 300 MiB budget, pick on the blueprint | 285 | 634 MiB | 576 | 155 s |
| rainbow, 300 MiB budget, proxy pick | 285 | 555 MiB | 528 | 138 s |
| rainbow, 150 MiB budget at i16, proxy pick | 150 (i16) | **392 MiB** | 592 | 127 s |
| rainbow, 200 MiB budget at i16, proxy pick | 199 (i16) | 411 MiB | 639 | 199 s |
| two-tone, 300 MiB budget, pick on the blueprint | 282 | 563 MiB | 441 | 119 s |
| two-tone, 300 MiB budget, proxy pick | 272 | 506 MiB | 401 | 53 s |
| rainbow, 300 MiB budget, 1 thread | 285 | 648 MiB | 1796 | 596 s |

The picking solve's WebAssembly memory stays resident until V8 collects it,
so it adds to the hybrid's peak. Hence the proxy, and, for rainbow, 16-bit
storage (`precision: 'i16'` with `wasmStorage`).
