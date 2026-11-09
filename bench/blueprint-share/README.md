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
