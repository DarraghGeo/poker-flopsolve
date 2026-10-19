# @toysolver/holdem

A **postflop Texas Hold'em solver**. Give it a board, a pot, stacks, two ranges and a
betting scheme; it solves to showdown.

There is no preflop round. The ranges you supply already encode whatever spot you are in,
so the solver starts from a dead pot with both players even.

```ts
import { defineSpot, solve } from '@toysolver/holdem';

const spot = defineSpot({
  board: 'As Kh 7d 2c',      // 3, 4 or 5 cards
  pot: 60,
  stack: 120,                // effective, behind, per player
  oop: '22+,A2s+,K9s+,AJo+', // acts first on every street
  ip: '22+,A8s+,KTs+,ATo+',
  betSizes: [[0.5, 1.0]],    // pot fractions; one row per round, or one for all
  maxRaises: 1,
});

const sol = solve(spot, { iterations: 500 });

sol.ev(0);                     // chips per hand, out of position
sol.exploitabilityPercent();   // distance from equilibrium, % of pot
sol.strategyAt(node, board);   // per-combination action frequencies
```

## Command line

```bash
npm run solve -- --board "As Kh 7d 2c" --pot 60 --stack 120 \
  --oop "22+,A2s+,K9s+,AJo+" --ip "22+,A8s+,KTs+,ATo+" \
  --bet "0.5,1.0" --iters 500
```

`--help` lists every flag.

## Browser UI

```bash
npm run ui     # -> http://localhost:5174
```

Pick a preset or type a spot, solve, then walk the betting tree and read the strategy as a
13x13 rank matrix. Each cell splits horizontally into one column per individual combination
— six for a pair, four suited, twelve offsuit — and each column fills vertically with that
combination's own action mix. Nothing is averaged.

Column height is how often that combination actually reaches the node, so the grid shows
the range narrowing as you descend a line. A combination the board has taken leaves its
column empty. Hovering gives the exact frequencies and reach.

Nodes past a deal get a runout picker: step rivers with the arrow keys, or jump to one by
number. The line reaching the selected node is spelled out above the grid —
`OOP check → IP check → deal → OOP check → IP to act`.

Solving runs in its own worker thread, so progress streams and **Stop** ends early while
keeping the partial answer.

## Ranges

```
AA  KK-99  22+          pairs, spans, and "and better"
AKs  A2s+  A5s-A2s      suited
AKo  KTo+               offsuit
AK                      both
AsKh                    one exact combination
Ax  AXs  AXo            any second card, optionally constrained
random                  everything
AKo:0.5  QQ:25%         partial weights
```

Weights matter: a solver range is routinely partial, and a later segment overrides an
earlier one, so `random:0.1, AA:1` is a light range that always has aces. `Xo` forms
include the pair, because a pair is not suited; `Xs` forms do not.

Board cards are removed from both ranges automatically.

## Raise sizes

`betSizes` also size raises unless `raiseSizes` is given. A raise size can be a multiple of
the bet being faced, measured from what both players had in when the round opened:

```ts
defineSpot({ ..., betSizes: [[0.5]], raiseSizes: [{ times: 3 }], maxRaises: 2 });
// bet 40 into 80, raise to 120
```

## Betting per round

`raiseSizes`, `maxRaises` and `allowAllIn` can each be given once for every round, or one
per round like `betSizes`. A shove can also be a round's only bet size:

```ts
// Flop: one size, no raise. Turn: two sizes, one raise. River: shove or check.
defineSpot({ ..., board: 'Qs Jh 4d',
  betSizes: [[0.33], [0.5, 1], ['allin']],
  maxRaises: [1, 2, 1],
  raiseSizes: [{ times: 3 }],
});
```

A subgame keeps the rounds from its own onwards.

## Reading a solved spot

`createRun` returns the solver itself as `run.solver`, for analysis after (or between)
iterations, without changing anything:

- `solver.valuesAt(node, board, traverser, reachMe, reachOpp, live, liveCount)` gives the
  traverser's counterfactual values from any node under the average strategy, for reach
  vectors you choose. Values are linear in `reachOpp`, so a one-hot opponent reach gives
  each hand's value against one specific opposing hand.
- `solver.pairValuesAt(node, board, traverser, hands, handReach, live, liveCount)` gives
  the same as `valuesAt` with a one-hot opponent reach, for many opposing hands in one
  walk: a row of values against each hand alone. Sharing the walk, the strategy lookups
  and kernel-free terminals makes it about 3× faster than one `valuesAt` per hand on turns
  and flops.
- `solver.exploitability()` is the best-response measure for whatever strategy sums the
  solver holds.

`createRun(spot, { analysisOnly: true })` allocates only the strategy sums (single
precision, one thread, no regrets). Fill `run.solver.ctx.strategySum` from a saved or
modified strategy, then analyse it the same way. Such a run must never be stepped.

## Re-solving from a node

Solve the whole spot with a coarse tree, then re-solve the street you are looking at
with a rich one:

```ts
const coarse = solve(defineSpot({ ...spot, betSizes: [[0.66]] }), { targetPercent: 0.5 });
const turn = defineSpot(coarse.subgameAt(node, board, { betSizes: [[0.33, 0.75, 1.25]], maxRaises: 2 }));
const detailed = solve(turn, { targetPercent: 0.3 });
```

`solution.subgameAt(node, board, betting?)` returns the spot that starts at a node that
opens a betting round. It carries the board dealt there, the pot and stacks as they stand,
and each player's range as their reach there (`solution.reachAt`). Ranges accept these
per-combination weights as well as notation. Measured on the bench flop: the coarse flop
took 27 s and 150 MB with 3 threads. Each turn, re-solved with three sizes, two raises and
a shove, took about 7 s and 15 MB. The same rich tree solved from the flop would need
1.9 GB.

On lines the original solution plays, a re-solve with the same betting reproduces its
value to four decimals. On lines it barely plays, the original strategy was never pushed
to equilibrium, because exploitability weights each line by how often it is reached. The
re-solve is the better answer there.

This is *unsafe* re-solving. The subgame is solved for the ranges that arrive, so its
strategy can be exploitable in ways the original allowed for. It also does not make the
earlier streets any more accurate than their coarse model of the future.

## Performance

Measured on an Apple M2, single threaded:

| Entry | Ranges | Slots | Memory | Solve |
|---|---|---|---|---|
| River | 7 vs 6 | 52 | < 1 MB | 3,000 iters in 0.4 s |
| Turn | 165 vs 160 | 455k | 3.8 MB | 500 iters in 8 s |
| Flop | 27 vs 36 | 3.0M | 41 MB | 120 iters in 21 s |
| Flop | 211 vs 203 | 35.3M | 287 MB | 60 iters in 80 s |

`defineSpot` reports the projected cost before anything is allocated, and refuses a spot
over `maxBytes` with concrete suggestions. `maxCombos` caps range width.

### 16-bit storage

A spot too big for 32-bit storage under `maxBytes` is solved at 16 bits instead
(`precision: 'i16'` forces it). Regrets and strategy sums are stored as 16-bit integers with
one scale per node and board, about halving memory. `estimate.compressedBytes` reports
that size, and a spot is refused only if even that exceeds `maxBytes`. Measured on AsKh7d:

| Flop | Ranges | 32-bit | 16-bit |
|---|---|---|---|
| 1 size, 1 raise | 198 vs 165 | 150 MB | 85 MB |
| 2 sizes, 1 raise | 198 vs 165 | 824 MB | 425 MB |
| 2 sizes, 1 raise | 309 vs 424 | 1,645 MB | 836 MB |
| 2 sizes, 2 raises | 309 vs 424 | 3,344 MB | 1,689 MB |

The 309 vs 424, two-size flop solved with two threads at a peak RSS of about 1.1 GB, so it
fits a 2 GB machine. It reaches each accuracy target in the same number of iterations as
32-bit, but each iteration costs about 15–20% more, because every update re-encodes its
block. Strategy sums round up or down at random, weighted by the remainder: rounded to
nearest, small sums lose most of each iteration's contribution and exploitability stalls
near 0.04% of pot. The randomness is a hash of the slot and iteration, so solves stay
deterministic at any thread count.

### Algorithm and benchmark

The default update rule is Discounted CFR (`algorithm: 'dcfr'`, α 1.5, β 0, γ 2). CFR+
is still available as `algorithm: 'cfr+'`. `npm run bench` times a fixed river, turn, flop
and two-tone flop. Measured in a 4-core cloud container, seconds of solving to reach each
target (exploitability checks excluded):

| Spot | Threads | CFR+ to 1% | DCFR to 1% | CFR+ to 0.3% | DCFR to 0.3% |
|---|---|---|---|---|---|
| Turn, 12 MB | 1 | 7.1 s (82 it) | 4.5 s (53 it) | 14.1 s (170 it) | 7.9 s (95 it) |
| Flop, 150 MB | 1 | 49 s (46 it) | 36 s (34 it) | 101 s (95 it) | 64 s (61 it) |
| Flop, 150 MB | 3 | 23 s | 17 s | 45 s | 29 s |
| Two-tone flop, 162 MB | 3 | 19 s (34 it) | 16 s (29 it) | 38 s (71 it) | 28 s (53 it) |

The solver is compute-bound rather than memory-bound — a 150 MB flop streams its
accumulators at about 0.25 GB/s — so the cost of an iteration tracks the work in it, not
its bytes.

### Accuracy targets

`solve(spot, { targetPercent })` stops as soon as exploitability reaches that percentage of
the pot, making `iterations` a cap rather than a plan. This is the cheapest way to cut solve
time, because the last decimal place of accuracy costs most of the run:

| Target | Iterations | Time |
|---|---|---|
| 2% | 20 | 0.28 s |
| 1% | 24 | 0.26 s |
| 0.5% | 39 | 0.29 s |
| 0.25% | 57 | 0.35 s |
| 0.1% | 127 | 0.57 s |
| 0.05% | 200 | 0.73 s |
| none (500 iterations) | 500 | 1.43 s |

As a guide, 1% of pot is a sketch, 0.5% is enough to read strategies off, and 0.1% is
publishable. On the flop preset in the browser UI, a 0.5% target finishes in 2 s against an
estimated 24 s for the full iteration count.

Checking is not free: it is a full best-response pass for both players, about one
iteration's work, spread across the same threads as the solve. Rather than pick a cadence, the solver predicts when the target will be met — CFR+
exploitability falls as roughly `C / T^p`, so two measurements pin the crossing — and checks
just short of it. On a 500-iteration run that is 7 checks and 4% overhead, against 50 checks
and 23% for a fixed cadence of 10.

`solution.stoppedAt` is `'target'` or `'iterations'`. The second with a target set means the
target was *not* reached and the answer is looser than asked for, which the CLI and the UI
both say out loud.

### Workers

`solve(spot, { workers })` splits the runouts across threads, the calling thread included:
`workers: 2` is the caller and one worker thread. Storage is indexed runout-outermost, so
each thread owns a disjoint slice of shared memory and takes no locks. Only the round above
the split stays on the main thread alone, because CFR+ clamps regrets at zero and partial
sums cannot be added through a clamp. Exploitability and EV passes are split the same way.

Measured on a 133 vs 145 combo spot, 8 cores:

| Workers | Turn, 400 iters | Flop, 100 iters |
|---|---|---|
| 1 | 3.6 s | 82.1 s |
| 2 | 2.0 s | — |
| 4 | 1.3 s | 24.8 s |
| 7 (default) | 1.2 s | 18.6 s |
| 8 | 1.2 s | 19.3 s |

`workers: 'auto'` uses one less than the machine's parallelism, but never fewer than two, so
a 2-core machine still splits; `workers: 1` stays on one thread. A river spot has a single runout and silently stays single-threaded whatever is
asked for.

Results are bitwise deterministic at a fixed worker count, but agree with a different count
only to floating point: a worker sums its own slice before the totals are summed across
workers, which associates the same addition differently, and the non-linear CFR+ clamp
compounds that rounding. Measured, the gap sits at 1e-15 through 300 iterations and reaches
1e-7 by 2,000 — always orders of magnitude below the exploitability at that point.

The single largest cost is the number of runouts: a river board has one, a turn 48, a flop
2,352. Tree width matters nearly as much — a second bet size roughly quadruples the work.

**Suit isomorphism is deliberately absent.** Fixing the board is exactly what destroys the
symmetry: measured, a rainbow flop's stabiliser is trivial and gains **1.00×**, two-tone
**1.65×**, monotone **3.48×**. It is not worth the complexity here, which is the opposite
of the conclusion in the parameterised solver alongside this one, where the flop itself is
enumerated and can be canonicalised for a 12× win.

## Verification

- **A known answer.** The clairvoyance game — nuts and air against pure bluffcatchers on a
  dry board — has a closed-form equilibrium. At a bet of `f` times the pot the solver
  defends `1/(1+f)` and bluffs `f/(1+2f)` of its betting range, and reaches the
  hand-computed expected value. Asserted at three bet sizes.
- **The evaluator**, ported from `poker-bitvaljs`, is re-checked rather than trusted:
  all 2,598,960 five-card hands against an independent classifier with exact textbook
  frequencies, 200,000 seven-card hands against the best of their 21 five-card subsets, and
  invariance under every suit relabelling.
- **Card removal** is checked against a brute-force O(K²) reference with weighted,
  partially-zero reach, from flop through river.
- **Normalisation** is pinned at every entry point by a royal flush on the flop, which no
  runout can beat or chop: the expected value must be exactly half the pot whether one, 48
  or 2,352 completions remain. This caught a real bug where values were scaled by the
  runout count — invisible on a river board, where that factor is 1.
- Zero-sum to 1e-9, exploitability non-negative and non-increasing, and every strategy a
  probability distribution.

```bash
npm test
```

## License

MIT
