# Street compression under Lite

`streetCompression` gives every turn and river board a kept set of hands of its own, inside one
solve; `compressRanges` thins the ranges for the flop. This measures the three together on issue
#47's betting (0.33 / 0.75 / 1.5 pot, a 0.75 raise, all-in, three aggressions; pot 55, stack 975).

| script | what it does |
|---|---|
| `session.ts [board] [workers]` | Node: an `openLite` session on the wide ranges, plain and with each variant's kept sets: seconds and iterations to settle for the opening solve, a range reweighed twice, a flop bet size moved and a hand class added, then the exploitability of where it ended, in the same tree with every hand on every runout |
| `measure.ts [board,...] [workers] [passes]` | Node: Lite's blueprint as it is and with each variant in `VARIANTS`, each run for the same number of passes: boards stored, hands kept on later boards, storage, the time to define the spot (which chooses the kept sets), the time for the passes, exploitability in the same tree with every hand on every runout, and the root play against plain Lite's |

`VARIANTS` separates variants with `;` and a variant's streets with `,`:
`"lite;flop=0.01;river=0.01;turn=0.01,river=0.02"`. `flop` is `compressRanges`' tolerance, `turn`
and `river` are `streetCompression`'s. `RANGES=<file>` reads two ranges, out of position first, one
per line, in place of the bench ranges; `wide-ranges.txt` is the pair the wide-range log used
(407–426 and 541–570 combinations a side once the board is removed).

Columns:

- **kept on turns / rivers**: the share of the hands that could be held on a board that its kept
  set holds, and how many could be held, a board and a player on average. Under a compressed turn
  a river's candidates are the hands its turn kept.
- **define s**: `defineSpot`, which chooses the kept sets: the compressor once a turn board, and a
  clustering by strength once a river board.
- **passes s**: the passes are run ten at a time and the quickest ten counted for all of them: a
  machine doing something else beside the solve moved whole runs by a third between repeats.
- **x Lite**: that time against plain Lite's on the same board.
- **exploitable %**: `trueExploitabilityPercent()`: the strategy played in the same tree with
  every hand on every runout, a hand that is not kept on a board playing as its stand-in. Plain
  Lite's own figure is the floor: history sharing and runout buckets are in it.
- **root apart**: the largest difference, in percentage points, in how often the range takes an
  action at the root or at in position's decision after a check, against plain Lite's
  (`bench/range-compress` measures two plain solves 1.8–3.0 apart).

`out/` holds what it printed, on 4 threads at 200 passes:

- `bench-ranges-4t.log`: the bench ranges, 165–223 combinations a side.
- `wide-ranges-4t.log`: `wide-ranges.txt`.
- `session-two-tone-4t.log`: `session.ts` on Ts 9s 4h.

A compressed turn turns runout buckets off (a bucketed river deal relabels hands, and a turn's kept
hands are chosen for its own deals), so those rows store more boards than plain Lite does.
