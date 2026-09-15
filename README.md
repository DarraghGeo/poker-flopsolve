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
