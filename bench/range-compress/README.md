# Range compression under Lite (issue #156)

`solveLite` with and without `compressRanges`, on issue #47's betting (0.33 / 0.75 / 1.5 pot, a
0.75 raise, all-in, three aggressions; pot 55, stack 975).

| script | what it does |
|---|---|
| `measure.ts [board,...] [workers] [tolerance,...]` | Node: Lite as it is, Lite again to half the settle tolerance, and Lite with `compressRanges` at each tolerance: combinations, storage, iterations to settle, wall time, and how far the root play is from the first |

`RANGES=<file>` reads two ranges, out of position first, one per line, in place of the bench
ranges.

"Root play apart" is the largest difference, in percentage points, in how often the range takes
an action at the root or at in position's decision after a check, against plain Lite. `again`
is plain Lite stopped at half the settle tolerance: how far two solves of the same ranges are
apart by the same measure.

`out/` holds what it printed, on 4 threads:

- `wide-ranges-4t.log`: a button open against a big-blind call from a preflop solver, 433–518
  weighted combinations a side (the ranges themselves are not in the repository). 1.7–2.2 times
  as fast at tolerance 0.01 and 2.1–2.8 at 0.02, in 0.42–0.72 and 0.30–0.62 of the storage, the
  root play 1.2–2.7 points from plain Lite's where two plain solves were 1.8–3.0 apart.
- `bench-ranges-4t.log`: the bench ranges, about 200 combinations a side. 1.3–1.5 times as fast
  on the rainbow and two-tone flops; slower, with more storage, on the monotone flop at
  tolerance 0.01. These ranges are the same in every suit and nearly so across neighbouring
  ranks, which is what `runoutBuckets` and the suit symmetry fold boards on; a range with
  combinations taken out has less of both.

What is not measured here: root play loss against an unshared blueprint, and turn re-solves
(`bench/lite/measure.ts`'s yardsticks), and anything in a browser.
