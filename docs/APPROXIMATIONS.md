# Approximations measured and left out

Every approximation this solver tried and does not offer, or offers only as part of a preset, with the numbers that decided it and the issue that measured it. What *is* offered, and what each option costs, is in the README's [Choosing an approximation](../README.md#choosing-an-approximation) and its [options inventory](../README.md#options-inventory).

This record lived in the `Approximations` type in `src/index.ts` until issue #115 moved it here, so the public type stays readable. Nothing was re-measured in the move. Where an entry gives a commit, the implementation is in this repository's history there; where it names a `bench/` directory, the harness and logs are still in the tree.

Unless an entry says otherwise, the spots are the README's bench spots: As Kh 7d (rainbow), Ks 9s 4s (monotone) and Ts 9s 4h (two-tone), bench ranges, and for the memory work the round's target tree T (As Kh 7d, pot 55, stack 975, 0.33 / 0.75 / 1.5 pot, a 0.75 raise and all-in, three aggressions, 17.2 GiB at 32 bits) and its smaller sibling T₀ (all-in as the only raise, two aggressions).

## Threshold pruning

Threshold pruning — skipping opponent actions taken with negligible
reach — was built and measured, and is deliberately not offered: a
threshold on reach mass also skips deep lines that are rare overall but
matter to the few hands that reach them, their strategy stops training,
and the best response walks straight into it. On a wide turn spot it
plateaued near 0.8% of pot where the unpruned solve reached 0.17%, for
at most 15% less time per iteration.

## River hand buckets

River hand buckets — one strategy per set of hands of equal strength
and equal ranks, suits told apart only where a flush is possible — were
built and measured too, and also left out. The solver updates every hand
in one vector pass, so fewer separate strategies did not mean fewer
iterations, while the lost blocker detail put a floor under accuracy:
105 iterations to 0.3% of pot on a turn spot instead of 85, and a
plateau near 0.15% where the exact solve went on to 0.1%.

## Chance sampling by plain 1/p weighting

Chance sampling — walking each river deal in training with probability
p and weighting it by 1/p, with DCFR discounts caught up for deals left
out — was built and measured as well. Iterations got cheaper, but the
sampling noise, which DCFR's weighting of recent iterations amplifies,
cost more iterations than it saved: a flop spot on 4 threads reached
0.3% of pot in 14.1 s exact, 23.1 s at p = 0.5, and not within 400
iterations at p = 0.25; at best it broke even to 1%.

## Hand classes at the flop root

Hand classes at the flop root — each player's flop vector shortened to
weighted classes of nearly equivalent combos (rank pair, suitedness, and
how many flop cards share each hole card's suit), expanded back to
combos at the turn deal — were counted and not built, because they
cannot pay: the flop round is 0.005% to 0.02% of the decision slots and
terminal work of the bench flop spots (rainbow, monotone, and the
same in pairs-and-broadway form), the river 99%, so shortening the flop
vectors 2 to 3 times (198 combos to 92 classes on As Kh 7d, 217 to 75 on
Ks 9s 4s) bounds the speed-up at 0.02%.

## Hand classes through every street (#40)

Carried through every street (#40), against the packed hand lists, the
same classes shorten river vectors 1.9 to 2.1 times (784,806 to 384,948
on As Kh 7d, 171,442 to 90,704 on Ks 9s 4s, 177,944 to 84,404 on Ks 9s
4s in pairs and broadway), and they were measured before building
(`bench/hand-classes/`). The test was the best case: every class's
regrets and strategy sums were tied after each iteration, so each
decision played one strategy per class while payoffs and card removal
stayed exact. They are not offered, for two reasons.

- Accuracy. On As Kh 7d the classes put a hearts flush draw and the
  same ranks in clubs together, and they stalled at 0.53% of pot, where
  the exact solve reaches 0.3% in 60 iterations and 0.1% in 105.
  Keying the suit counts on the current board instead keeps draws
  apart. That shortened rainbow vectors only 1.6 times (1.1 times on
  monotone), needed twice the iterations to reach 0.1%, and stalled
  near 0.09%. On Ks 9s 4s only spades can flush, so the classes cost
  little: the same iterations to 0.3%, 10–15% more to 0.1%, and
  0.024% after 500 iterations where the exact solve had 0.005%. In
  pairs and broadway they cost nothing, because the exact solve already
  plays every member of a class alike.
- Speed. Only the decision rows shrink. The fold and showdown kernels
  must still read each hand's own two cards to keep card removal
  exact, and they are about 70% of an iteration: single-threaded in a
  cloud container, Ks 9s 4s took 93 ms, and 27 ms with the engine's
  fold and showdown calls replaced by zeros; As Kh 7d took 358 and 116
  ms. So the bound is
  1.15 to 1.2 times, before the cost of expanding classes into hands at
  every terminal. Kernels at class length would need each class's
  blocked mass averaged over its members. That is only approximate, and
  it can only make the floors above worse.

## Regret-based pruning

Regret-based pruning — skipping the subtree below an action no hand of
the actor plays (Brown & Sandholm, 2015) — was measured before building
and is not offered either; `bench/prune-census.ts` counts the work it
could skip. The provably safe form cannot skip anything under this DCFR:
with β = 0 a negative regret is halved every iteration, so it never
falls below twice the largest one-iteration regret, and the skip it
proves safe is zero iterations. The unsafe form's ceiling is small too.
Below actions played by no hand sat 4–10% of the work to reach 0.5% and
0.3% of pot, on the bench flop, monotone, wide-flop and turn spots and
on pairs-and-broadway ranges. Most of that was iterations 2–5, before
every board has a hand that likes each action, and after them it was
1–8% per iteration. Half of it, at opponent nodes, could be skipped
without changing any value, but the traverser's own nodes below would
then miss their discount and strategy-sum update.

## Depth-limited solving (#21)

Depth-limited solving (Brown, Sandholm & Amos, 2018) was built and
measured too: the tree stopped at the deal of the river (or the turn),
and at each leaf both players chose per hand, unseen by the other, one
of k fixed continuations: check down; value-bet the top 30% with
balanced bluffs and call by MDF; that betting ×1.5; that calling ×1.5;
top-half bet and call. CFR trained the choice. It cut flop memory about
tenfold (246 MB to 22 MB) but lost on accuracy and did not win on speed.
Against an exact solve to 0.1% of pot, the depth-limited game's own
equilibrium kept per-combination root EVs 2–5% of pot off on average
(8–20% for single combos), with draws and made hands worst and air
nearly right. That is the implied-odds and value-extraction play a fixed
continuation keyed on starting-range percentile cannot follow once the
flop and turn have narrowed the ranges. The exact solver stopped at 15 s,
single-threaded in Chromium, was closer on every spot measured: 0.02% on
the monotone flop, 0.3–0.6% on the wide one, 2.0–2.4% on AsKh7d at pot
100, where the best depth-limited run was 4.2%. It was not faster either.
These trees' river betting is one size with no raise, already as cheap
as a leaf's five terminal passes, so with k ≥ 2 an iteration cost as
much as the full tree. Cutting at the turn was cheaper still, and worse:
3–14% mean error. The implementation is in this repository's history
(commit 32e8424, issue #21).

## Depth-limited solving from a blueprint, for memory (#48)

The same idea was measured again for memory (issue #48), with
continuations from a solved blueprint instead of fixed rules and the cut
at the turn deal, and is not offered either. A one-size blueprint (0.75
pot, no raise, 235 MiB) was solved first. Each flop line into the turn
took the blueprint's turn and river strategy from the blueprint line most
like it, played out from the line's real pot and stacks. Both players
then picked per hand among k continuations: the blueprint, and copies
leaning ×5 toward folding, calling or raising. The flop was solved with
every size and raise.

Leaf values were stored as each player's EV per hand for each pair of
picks, a pair of hands worth the difference. Plain per-hand vectors
made the leaf game non-zero-sum and CFR cycled. Exact per-pair tables
cost about n times the walks (n the opponent's hands) to build.

It fit easily. On the round's target spot (As Kh 7d, pot 55, stack 975,
sizes 0.33 / 0.75 / 1.5, a 0.75 raise, three aggressions; 17 GiB exact)
it peaked at 0.5–0.8 GiB and took 31–55 s on 4 threads in Chromium. It
lost on accuracy.

Root EV per combination was off by these amounts on average, in % of
pot, OOP / IP:

- 4.5 / 4.4 against an exact T₀ (all-in-only raise, 0.84% of pot),
  where the one-size blueprint alone was 5.2 / 6.4;
- 3.1–3.6 / 2.3–3.8 on Ks 9s 4s, against 3.5 / 4.4;
- 6.3 / 4.7–6.1 on a T-shaped spot at SPR 3, against 2.0 / 3.0.

Single hands were off by up to 35% of pot. The best root bet size per
hand matched the exact solve for 32–37% of the range on As Kh 7d,
chance for three sizes. More continuations (k = 2, 4) never helped.
Exact per-pair leaf tables only brought it level with the blueprint
alone. So it does no better than solving its own blueprint, which
already fits. The implementation and bench are in this repository's
history (commit ab0b66a, issue #48).

## Cheaper EV estimates (#27)

Cheaper EV estimates (issue #27) were measured offline with bench/ev on
three flops, against each solve run on to 0.045% of pot, and none is
offered here. The idea was that per-hand EVs settle before
exploitability does; they do not. The range-weighted mean error of
per-hand root EVs runs at 1 to 2.5 times the exploitability throughout,
so getting under 1% of pot takes about 47 iterations on every spot.
Stopping on EV stability stopped too early: the change between checks
understates the error left, and at ε 0.5% it stopped with 2.2–2.6% of
pot still wrong. `targetPercent` already tracks the error. Bracketing
with the best-response values did not help either: their midpoint with
the average was worse than the average alone, and the best blend, fitted
in hindsight, gained at most 10% with a weight that drifted from 0.1 to
0.85 over a run. Extrapolating the EV sequence was unstable because
DCFR's average values do not follow a clean C/T^p. Even with each
correction capped at three times the last step, Richardson on the
whole vector beat the plain average at only 11 of 51 checkpoints and
was up to 8 times worse; per-hand Aitken beat it at 17 of 51 and was
up to 4 times worse. The one win was evaluating EVs under the
current profile rather than the average: at equal iterations its error
was lower at 62 of 65 checkpoints, often by 2 to 4 times. Issue #35 takes
that up as its own opt-in.

## Learned turn-leaf values

Learned turn-leaf values — solving only the flop betting and asking a
model for each hand's value where the turn is dealt, as DeepStack does —
were measured too (`bench/leaf/`), and are not offered: no model came
near the accuracy the exact solve already reaches in the time budget.
Fitted on turn spots solved to 0.3% of pot and scored on the real turn
leaves of 0.1% flop solves, per-hand EV was off by 9–17% of the leaf pot
for equity times a realisation factor per hand class (a hand's value at
a stack-to-pot ratio of 2 is not bounded by its share of the pot: strong
hands win stacks, weak ones fold), 3–5% for a cubic in equity per class,
and 1.7–2.7% for an MLP on equity-distribution features trained on
10,000 spots. Errors move together across turn cards, so averaging them
into the flop barely cancels them: 1.1–4.2% of the flop pot with the
flop strategy held at the reference, where the exact solve stopped at
15 s, single-threaded in Chromium, is within 0.1–1.7% at the root. Nor
would it be faster: the network over one leaf's turn cards took about
140 ms, three leaves more than an exact flop iteration (about 350 ms),
before the range-dependent features it needs.

## A library of precomputed flops (#30)

A library of precomputed flops (#30) — the 1,755 suit-isomorphic flops
solved for a few archetype ranges, answering a query by lookup and then
warm-starting — was measured and is not offered. The experiment is in
`bench/library/`: the bench `flop` (AsKh7d) and `monotone` (Ks9s4s)
spots and a wide AsKh7d (213 vs 205 combos), references solved to 0.1%
of pot, a budget of 15 s single-threaded in Chromium (36, 96 and 36
iterations), errors in per-combination root EV, % of pot.

- A lookup is only as good as the nearest stored spot. From a flop a
  rank swap away (AsKh6d for AsKh7d, Ks9s5s for Ks9s4s) the mean error
  was 0.8–1.8 and the largest 7–40, since the hands whose role changes
  are simply wrong; from AsQh7d or Ks8s4s the mean was 3–8. For a custom range on the same flop,
  re-weighting the archetype's per-matchup values (the strategies cannot
  adapt) gave a mean of 1.3–4.5 and a largest of 3–14. Cold solves
  reached a mean of 0.2–2.4 and a largest of 0.4–4.9 inside the budget,
  so a lookup wins only in the first seconds and never on the worst
  hands.
- A warm start from the whole of a neighbour's solve is fast (0.5% in 8
  iterations instead of 52) and stays available in-session as
  `SolveOptions.warmCards`. But the whole tree is 9–33 MB per flop at a
  byte per value, 16–58 GB per archetype for every flop. What a library
  can ship is the flop's decisions (~2 KB a flop) or the flop's and the
  turn's (~0.2 MB). Seeded with the flop's alone, solves took 76–92
  iterations to 0.5% where cold took 40–52: the later streets start cold
  but are discounted as if late in the solve. Restarting the count at 10
  recovered 44–52 on rainbow flops and 44–56 on monotone ones (a cold
  solve restarted at 10, nothing seeded, took 52–68); flop and turn,
  52–68. At most 15% fewer iterations on some spots and more on others,
  for thousands of precomputed solves per tree and archetype, rebuilt
  whenever the defaults change.

## Out-of-core river storage (#55)

Out-of-core river storage (#55) — the flop and turn in memory, the
river's accumulators in an Origin Private File System file paged through
one buffer, one turn card of one turn chance node at a time and in file
order — was built, measured and is not offered. It is exact (bit for bit
at 32 bits) and fits the round's target spot T (AsKh7d, three sizes a
street, 8.7 GiB at 16 bits) in a tab: 0.33 GiB peak in headless
Chromium against a 10 GiB OPFS quota, with I/O 5–8% of each iteration
(sequential reads 3–4.5 GiB/s, read and write back about 1 GiB/s). What
it cannot change is T's compute: 81 s an iteration on one thread, and
a few hundred iterations to 0.3% of pot (T₀, smaller, was still at 3.8%
after 80), so hours per solve where the bar was two minutes. Each
iteration also rewrites the whole river file, terabytes per solve on a
laptop SSD, and a private window keeps OPFS in memory and failed before
1 GiB. CFR-D, re-solving every river subgame from the trunk's ranges
each iteration, would cost tens of times more and was not built. The
implementation is in this repository's history (commit 0f80fcc);
`bench/ooc/` keeps the OPFS throughput and sizing benchmarks.

## Pruning for space (#52)

Pruning for space (#52) — freeing the storage under lines no hand plays,
as best-response pruning does (Brown & Sandholm, 2017), and rebuilding
it if the line comes back — was measured before building and is not
offered. `bench/prune-space-census.ts` walks both players' reach under
the current profile after every iteration and counts the regret and
strategy-sum storage of blocks (a node on one board) that one player or
the other reaches with no hand. That is everything freeing could release.
On T₀ (AsKh7d, pot 55, stack 975, bets 33/75/150%, all-in raise, two
aggressions, 5.1 GiB at f32) it was 2.8%, 3.4%, 7.6% and 15.8% of
storage at iterations 20, 50, 100 and 200 (1.1% of pot). Only 6.0% had
stayed unreached for the last 50 iterations, and no decision node was
unreached on every board it is dealt on, which is the unit a whole-node
allocator would free. The target tree itself on Ks9s4s (3.75 GiB) was
alike: 15.0% per block at iteration 150 (2.5% of pot), 3.3% for 50
iterations running, 0% per node. Turn-rooted copies of the target's
betting, solved to 0.3–0.6% of pot, reached 15–20% per block and 3–4%
per node. Some hand on some board keeps every line alive: per node,
almost nothing can be freed, and per block, freeing all of it would
still leave the target at about 14 GiB at f32, where 2 GiB needs a
cut of about 9×.

The bound that makes freeing safe does not hold here either. With
DCFR's β = 0 a negative regret halves every iteration, so it never
falls below about twice the largest one-iteration regret, and the
number of iterations it proves an action stays unprofitable is zero
(as for pruning work, above). And WebAssembly memory grows but never
shrinks, so freed blocks only cut peak memory if storage starts small
and is allocated when the traversal first reaches it. That means a
per-block indirection through every kernel, the AssemblyScript engine,
the threads' shared memory, the 16-bit scales and warm starts, for an
8–20% saving at best.

## Runout clusters

Runout clusters — potential-aware card abstraction (Ganzfried &
Sandholm, 2014): turn and river cards grouped by k-medoids under the
earth mover's distance between each range's river-equity distribution,
plus flush, straight and pair texture, one walk per cluster with reach
gathered from every member — were built and measured as well, and left
out (prototype and data in bench/clusters, commit ef1fa9c). Rank swaps
alone cannot get there: suited connectors leave only ranks 2-5 swappable on
AsKh7d, so about 37 of 49 turns stay apart whatever k asks for, and the
rest need hands mapped by strength order, and that is where the error
comes from. At 15 s in the browser, single-threaded (measured before
#8 changed how strategy sums are weighted), true exploitability:
bench flop 2.3% at k = 16 (rivers 20) against 1.8% exact and 0.7% for
`runoutBuckets`, which also beat it on per-combination EV; both monotone
flops lost to exact on every measure. It won only where exact gets
almost nowhere in 15 s — a two-size wide flop, under 10 iterations —
and on the pairs-and-broadway flop's EVs (mean error 0.3% of pot against
1.0%, at 0.8% exploitability against 0.6%). Its error has a floor that
more iterations do not lower: on the bench flop 1.1-3.2% of pot mean
per-combination EV error and 2.2-4.7% exploitability from k = 16 down
to 4, on the wide flop 1.3-2.3% and 4-10%.

## Action translation of raises (#54)

Action translation of raises (#54) was built and measured, and is not
offered. The tree solved sized raises only over opening bets of chosen
sizes and offered just fold, call and the shove facing any other bet.
A full-tree raise over a 0.33 or 1.5 bet was read from the solved raise
over the nearest anchor, 0.75 (the pseudo-harmonic mapping is the
identity there, since the raise is 0.75 of the pot in both lines). Sized
raises are 64% of the round's target T (AsKh7d, 17.2 GiB at 32 bits):
those over a 0.33 bet 35%, over 0.75 20%, over 1.5 9%. Cutting them is
not enough. Raises over 0.75 alone left 9.1 GiB (4.6 at 16 bits), and
dropping every sized raise left 5.8 (2.9), both over the 2 GiB mark. On
the monotone Ks9s4s, where T is 3.75 GiB (1.9 at 16 bits, already
under the mark), raises over 0.75 alone took it to 2.0 GiB (1.0). That
solve needed 680 iterations to 0.3% of pot where the full tree needed
510, and ran 20 minutes on 4 threads. Its per-combination root EVs were
2.1–2.3% of pot off the full tree's on average and 8–9% at worst. Out
of position still chose the same root bet size for 93% of its range,
and for every hand with a clear preference. In position, after a check,
it agreed for 51%: a 0.33 bet that cannot be raised looks too good.
Translated into the full tree, the strategy was exploitable for 43% of
the pot. A turn spot with T's betting (AsKh7d2c) said the same: 2.2–3.4%
mean EV error and 31–68% exploitability across the anchor choices,
against 92–128% with no translation at all. The leak is the pairing.
With the full tree's own strategy put into only the translated
subtrees, exploitability was 0.2%. With the translated subtrees kept and
the full tree's strategy everywhere else, it was 0.14%. What fails is
the abstract game's 0.33 and 1.5 bets, shaped knowing they cannot be
raised, met by responses made for a range that could. Matching the
anchor's continue frequency at the first translated decision did not
help (39%). This is the pathology Ganzfried and Sandholm (2013)
describe. The implementation is in this repository's history (commit
f40fb76). `bench/translation/census.ts` keeps the storage census, and
`bench/translation/results/` keeps the measurements.

## Strategy grafting over bet sizes (#56)

Strategy grafting over bet sizes (#56; Waugh, Bard & Bowling, 2009) —
one size at a time in the same memory, stitched by a small game that
picks each hand's size — was built for the flop's opening bet,
measured, and is not offered. `bench/graft/` has it. R, the game it
approximates, is T's three sizes (and the shove) on the flop's opening
bet with 0.75 after it. Its grafts are cut down to the subtrees they
add: R's tree with every opening edge but one taken out, below OOP's
bet and below IP's bet after a check, plus check-check. Each is solved
alone for the ranges the stitch sends in, and only per-hand root values
are kept. The stitch is RM+ at the two opening decisions on those
values, one update per round of re-solving every piece; the trunk is
CFR-D's, two decisions deep.

Memory is what it promises: the largest piece is 868 MiB at 32 bits on
AsKh7d (191 MiB on Ks9s4s) where R is 3.7 GiB (0.81), and grafting
every street's opening bet would not grow it. Time and accuracy are
not. The pieces partition R, so a round costs about one solve of R,
and the stitch needs many rounds. The ranges move from round to round,
every piece re-equilibrates, and the trunk oscillates as CFR-D's does.
On Ks9s4s, 4 threads in Node, R itself solved to 0.25% of pot in 158
s. Grafted with 150 iterations a piece: the 0.75 blueprint's opening
spread over the three sizes, then one round, took 130 s and was 61% of
pot exploitable in R, with root EVs 1.1–2.9% of pot off per combination
on average and the preferred size agreeing with R's for 86% (OOP) and
47% (IP after a check) of hands. Four rounds took 396 s: 15%, 13–16%
off. Eight took 809 s: 6.6%, 8.5–9.8% off, 78% and 28%; RM+'s latest
stitch instead of its average, 820 s: 13%, 12–13% off. On AsKh7d one
round after the blueprint took 417 s and was 91% exploitable, 2.2% off,
the size agreeing for 22% and 41% of hands. On a small turn
spot that R solves to 0.18% in 4 s, 64 rounds took 186 s and were
still 7–11% exploitable. Even the reference's own opening strategy,
fed in for one round, came out 42% exploitable: an opening a hand never
takes (the shove, IP's bets after a check) gets an answer to the
pieces' floor range, not an equilibrium one, until the stitch's rounds
correct it. And it is still only R: exactly solved, R's root EVs are
0.8–1.0% of pot off T's per combination on Ks9s4s (T itself took 50
minutes on 4 threads to 0.23%), and T's turn and river sizes would
need grafts per flop line, which multiplies the solves.

## Growing bet sizes to a byte budget (#51)

Growing bet sizes adaptively to a byte budget (#51) was built and
measured. Only the fixed shape it found is offered, as
`SpotConfig.thinSizes`; `bench/adaptive/` has the growth. Growth starts
from one size per decision (0.75, a shove facing a bet where there is
no sized raise). Each round, it probes every cut size in a tree with it
added, warm-started from the current solve and stepped 60 iterations.
It scores each by its first-order gain per byte (Σ reach · σ · (Q −
the best kept action's Q)), whose rank correlation with the true gain
was 0.81 on a turn spot (0.71 for the best-response gain). It then adds
the best until the round's share of the budget is spent, and re-solves.
On As Kh 7d (bench ranges, pot 55, stack 975, 0.33 / 0.75 / 1.5 with a
shove, shove-only raises, 2 aggressions, 5.8 GiB), 1.7 GiB grown in 4
rounds had root EVs 1.0 / 1.2% of pot off the exact solve per
combination (3.9% at most), with 90% of OOP's range picking the same
size. The issue's static rule (3 sizes on flop and turn opening bets) had
1.6 / 1.3% and 13.5% in 2.0 GiB, and `thinSizes` 1.45 / 1.74% and
5.6–6.3% in 1.3 GiB. But the probes need a second tree beside the
current one: the process peaked at 7.5 GiB (8.7 GiB grown from three
flop sizes, and still 4.8 GiB with probes capped at 0.9 GiB for a
0.85 GiB tree), and growth took 31 to 43 minutes on 3 threads before
the final solve. On Ks 9s 4s, grown from one size, it never added the
flop sizes it needed and ended worse than the fixed rule (2.9 / 4.1%
against 2.1 / 1.9%). Its own census of the exact solve also showed that
how often a size is used is a poor guide to what it is worth. The flop's
0.75 bet was used 5% of the time for 0.005% of pot in 29% of the
storage, while river shove-raises, used 3% of the time, were worth 2%.

## Storage compressions left out of `compactStorage` (#50)

Of the storage compressions issue #50 measured, `compactStorage` offers
8-bit regrets and sums; these were left out. Against the bench flop's
0.016% of pot at 320 iterations with the full average:

- Dropping strategy sums on the turn and river only, the flop keeping
  its average: 0.053% (river only, 0.063%), worse than dropping them
  everywhere (0.035%), since an average above a current profile mixes
  strategies from different iterations. Offered only as `from`.
- Fewer bits: at 6 bits a floor near 0.15% of pot, at 4 bits near
  0.4-0.6%, so packing two regrets a byte, which the target spot would
  need to reach 2 GiB on this alone, does not pay.
- A log (µ-law) scale per block, 127 levels over 16 or 24 octaves:
  0.14% and 0.44%. Its few-percent steps sit at the top of the range,
  which is what regret matching reads; a per-hand linear scale puts the
  precision there and costs a byte per hand.
- Sparse regrets, only positive ones stored: 57-68% of regrets were
  positive at every checkpoint on every spot, so any index costs more
  than the dense byte.
- Recomputing the strategy at fold-or-call nodes (facing an all-in or
  the raise cap, 37-41% of the slots of the 3-size trees): no decision
  is choice-free, and those call frequencies are mixed bluff-catching
  choices that a best response recomputed each iteration does not
  converge to.

## Lite mode's speed trims (#100)

Lite mode (issue #100) measured these speed trims of its blueprint and
left them off or out. Rainbow As Kh 7d, issue #47's betting, in Node,
against the unshared blueprint, `settle` at its defaults; `bench/lite/out/`
has the logs:

- A wider `runoutBuckets` gap than 3 (6, 13): the same 1396 runouts on
  the bench ranges, whose suited connectors keep low cards apart.
- `allInThreshold: 0.67`: the same tree; at SPR 18 no bet commits two
  thirds of a stack.
- Sampling `p` 0.2: 92 ms an iteration against 0.35's 251, but the root
  play wandered, and the settle rule fired with it losing 0.043% of pot
  and per-hand EVs 1.5% off. p 0.5, 0.7 and 0.9 gave closer per-hand
  EVs (0.42-0.44% of pot against 0.44-0.50) for 1.8, 3.5 and 5.4 times
  the time an iteration, and no earlier settled root play per second.
- `noDonk` on the turn and river, and a flop capped at two aggressions:
  together 44% cheaper an iteration on rainbow, settled in 63 s instead
  of 100 with the root play still within 0.01% of pot. But they change
  the game. On Ts 9s 4h turn re-solves at the full betting gave the
  opponent 16% of the subgame pot instead of 4% (14% from the trimmed
  tree unshared and converged), and per-hand EVs were three times as far
  off. Each alone cost less but still too much: `noDonk` 6.7 / 12.9%
  (OOP / IP refined), the cap 7.6 / 3.8%, for 6-18% less time to settle.
  Both stay as `LiteOptions` for callers who want the speed.
- Warm-starting turn re-solves from the blueprint's regrets below the
  node (`copySubtree` before the first iteration): the opponent's gain
  moved by under 0.15% of the subgame pot at 100 and 300 iterations
  with DCFR's count restarted, and doubled with the blueprint's count
  kept. One turn/river size says little about the full betting's.

## Memory levers combined on T (#102)

Combinations of the memory levers on the round's target T (As Kh 7d,
17.2 GiB at 32 bits) were measured by issue #102 (`bench/combos/`), and
one is offered as `largeTree` in `poker-flopsolve/wasm-storage`:
`thinSizes`, 16-bit storage on the WebAssembly engine and
`chanceSampling`. Measured on 4 threads against `thinSizes` alone at 32
bits (600 iterations, 0.154% of pot), as the EV OOP's root play and
IP's after a check lose at its per-action values: the preset settled in
155 s at the reference's own floor (0.031 / 0.020% of pot) in 1.97 GiB
peak. These were left out:

- `shareHistories` on top of `thinSizes` (0.42 GiB at 16 bits): its
  exploitability stalls near 5% of pot (on T₀ 4.4%, where sharing
  alone sits at 8%: sharing's own floor, not a bug; it shares only
  rivers whose subtrees are identical, so thinning cannot make it
  share mismatched ones, and the threads split by runout, so a shared
  block is one thread's). Root play lost 0.048% of pot against 0.031%,
  per-hand root EVs 0.5% off against 0.05%, and it ran no faster, at
  1.7 s an iteration against 1.56 unsampled. With `runoutBuckets: 3`
  too, 0.25 GiB: the same root loss, 0.7–1.0% EV error, 5.1% at worst.
- `shareHistories` without `thinSizes` (1.48 GiB at 16 bits): it saves
  storage only, so an iteration costs the full tree's, 2.7 s on T₀
  where the thinned tree takes 0.6; T itself would take far beyond the
  15 minutes asked.
- `runoutBuckets: 3` on top (0.86 GiB, 87 s to settle with sampling,
  0.14 s an iteration): the same root play, but per-hand root EVs 0.2%
  of pot off on average and 2.3% at worst against 0.05 and 0.3. Left
  to the caller, who can add it to the preset's config.
- `compactStorage` in place of 16 bits: the same root play in 1.48 GiB
  peak instead of 1.97, about 10% slower, exploitability 0.53% of pot
  at 1600 iterations against 0.35. Offered as `storage: 'compact'`.
- `lineRunouts` (JavaScript engine only) was not measured on T: the
  round asked for the WebAssembly engine on 4 threads.

What `thinSizes` itself costs against the full tree was measured on T₀
against an exact solve (561 iterations, 0.22% of pot): root play 0.04%
of pot with or without the storage levers and sampling, per-hand root
EVs about 1.5% of pot off on average, 5.5% at worst.

## Recovering turn re-solves from a shared blueprint (#101)

Recovering turn re-solves from a `shareHistories` blueprint (#101):
`ShareHistories.keepLines` is what is offered. Measured and left out,
on AsKh7d (`bench/blueprint-share/recover.ts`, numbers in % of the
subgame pot as `keepLines` gives them, plain sharing 3.05 / 2.15):

- A re-solve with a cold river: that is what `resolveSubgame` already
  does at new betting. `subgameAt` hands over only the ranges, and the
  whole gap is the refined player's own range. Swapping in the
  unshared blueprint's range for that player alone gives 0.67 / 0.54.
- More blueprint iterations: 800 gave 2.48 / 2.36. The ranges' distance
  from the unshared ones went only from 0.086 to 0.081 (total
  variation, OOP), so the ranges do not settle later than the root.
- `weighting: 'counterfactual'`: 7.2 / 6.5, 15% of pot exploitable.
- Noise, which #105 found moves a shared solve's plateau: with
  `chanceSampling` at p 0.5, 0.7 and 0.9, 2.52 / 2.26, 2.78 / 1.99
  and 3.43 / 2.30; with 8-bit `compactStorage`, 2.38 / 1.89. The
  ranges stay 0.08–0.09 from the unshared ones (OOP).
- Refining the opened line: the shared solve continued 60 iterations
  with that line unshared, average included, then re-solved: 2.51 /
  1.89. The 400 shared iterations' average barely moves in 60.
- Keeping the top 3 lines but continuing from the picking solve
  rather than from cold: 1.66 / 0.89, against 1.10 / 0.83.
