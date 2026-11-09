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
