# Changelog

## 0.5.0-beta.5

The sixth beta of 0.5.0 (`npm install poker-flopsolve@beta`): everything since 0.5.0-beta.4.

### Editing a run's betting, pot or stack

- `run.edit(changes)` puts the run on the edited spot, behind the same object, started from its
  regrets and average: a bet or raise size added, removed or moved, more or fewer raises, another
  pot or stack. A size the tree did not have is seeded from its nearest neighbour. It takes
  1–4 ms on the bench river, 15–26 ms on the turn on 4 threads and about 0.2 s on the flop.
- `run.preview(changes)` gives the edited tree and the strategy the run would start from in
  0.5–5 ms on any street, without allocating anything.
- After an edit the river is back at 0.3% of pot in 1–6 ms and the turn in 44 ms to 0.7 s; the
  flop, where an iteration takes 70–130 ms, in one to three seconds.
- `warmTolerance` and `warmAverages` are new `warmStart` options: the largest size ratio still
  matched (`Infinity` seeds a new size from its neighbour), and whether the average is carried.
- In Node a run that has been replaced once (an edit, or growing for a hand) keeps as many
  engine threads waiting as it uses, so the next replacement does not wait for threads to start:
  a threaded turn edit took 56 ms the first time and 15–26 after.

## 0.5.0-beta.4

The fifth beta of 0.5.0 (`npm install poker-flopsolve@beta`): everything since 0.5.0-beta.3.

### Fixed: warm starts

- A warm start into a tree with fewer actions than its source read past its buffers where
  blocks are re-encoded (mirrored boards, 16-bit and compact storage): on wide hand lists it
  wrote NaN regrets at 32 bits and dropped seeded ones at 16. `copySubtree` had the same.
- Bet sizes are matched by the chips a bet adds over the pot. They were matched by the
  actor's whole investment over the pot, which drew sizes together once chips had gone in: after
  a flop bet and call, a third of the pot on the turn was seeded onto half of it.
- A solve of the same board with its cards in another order is taken, where it was refused.
- A spot is recognised as the same, and its average resumed, by the board and ranges it holds,
  not by how its configuration spells them; before, a run whose range `setRange` had changed
  was never the same spot as one given that range.
- `warmIteration` must be a whole number of zero or more.
- `run.warmStart.regrets` says whether regrets were carried: with it and `averages` both
  false (a warm start from an `analysisOnly` run of another spot), nothing was.

## 0.5.0-beta.3

The fourth beta of 0.5.0 (`npm install poker-flopsolve@beta`): everything since 0.5.0-beta.2.

### A run grows for the hands a range adds

- `run.setRange` no longer needs hands reserved ahead. For a hand the spot does not store, or a
  range that breaks a suit symmetry it folds, the run becomes one on a wider spot, started from
  its own regrets, behind the same `run` object. On the bench turn two classes added took 15 ms
  and then 0.29 s to 0.3% of pot, where storing every hand ahead made the re-solve 2.6 s and the
  first solve 4.2 s for 0.66; on the flop 0.3 s and 3.5 s, against 10.8 s and 90 s for 14.
- Changed from 0.5.0-beta.2, where such a range threw `RangeNotInPlaceError`: `{ grow: false }`
  keeps that. After a run grows, `run.spot` and `run.solver` are the wider run's, so code that
  kept either should read it again.
- `openLite` uses it, so a session's `setRange` is the run's own.

### Measured and not kept: Lite without its first full walk (issue #164)

- Under chance sampling the first iteration walks every deal. Letting it sample like any other
  cut it from 190–450 ms to 40–65 ms and left the blueprint more exploitable throughout: 3.9–4.0%
  of pot against 3.6–3.7 on Ks 9s 4s and 4.9 against 4.8 on Ts 9s 4h at the plateau, at two
  sampling rates. The first walk stays.

### A compressed blueprint's re-solves cover every hand again (issue #173)

- `LiteSolution.resolve` on a blueprint solved with `compressRanges` now solves the subgame for
  the caller's own ranges, every combination back in, where it solved for the kept
  combinations alone and left 22–54% of the range without a turn strategy. Each combination
  takes the play of the kept one nearest to it up to the street re-solved, and is solved in its
  own right from there. `rebuild: false` gives the old re-solve; `measure` keeps it, since it
  compares against the blueprint on its own ranges.
- Against the same turn re-solve from a blueprint of the full ranges (three flops, wide ranges,
  tolerance 0.01), a hand's root play differs by 5.3–6.9 points and 3–5% of the range is more
  than 25 points off, where two plain blueprints are 1.8–3.1 points and 0% apart. The re-solve
  takes what one from a full blueprint does.
- A combination's play before that street is still borrowed: the blueprint's flop strategy has
  nothing of its own for a hand it left out.
- So the whole strategy is not hard to exploit, though it loses little to sound play. On another
  solver, one flop, the full hand played this way gave up 0.06% of the pot against a reference
  opponent, less than a solve of the full ranges to 1% of pot (0.19%), and was 6.3% exploitable,
  more than one stopped at 5%.
- `rebuildRanges(source, compressed, solution, node, board)` is the step on its own;
  `compressRanges(spot, { standIns: true })` gives the map it needs (about 15 ms more), and
  `resolveSubgame` takes `ranges`.
- The vendored compressor is poker-rangecompress 0.3.0.

## 0.5.0-beta.2

The third beta of 0.5.0 (`npm install poker-flopsolve@beta`): everything since 0.5.0-beta.1.

### `openLite` takes any range, with every Lite option

- A session no longer refuses a range. One that adds a hand the blueprint does not store, or
  breaks a suit symmetry it folds, gets a new run started from the old one's regrets, so
  `oopReserve` and `ipReserve` are optional: five moves with no reserve took 83 s against 143
  for `solveLite` on As Kh 7d, 66 against 91 on Ts 9s 4h and 27 against 51 on Ks 9s 4s.
- `compressRanges` works in a session, compressing both ranges again at every move: 161 s
  against 193 on As Kh 7d, 110 against 178 on Ts 9s 4h and 50 against 90 on Ks 9s 4s, on wide
  ranges, less exploitable in 14 moves of 15.
- `algorithm: 'cfr+'` works in a session and in `run.setRange`, which clears its average and
  keeps its count: 105 s against 147, 70 against 103 and 20 against 58, less exploitable in 8
  moves of 15 and 0.2–1.4% of pot more on the monotone flop.
- `run.setRange` throws `RangeNotInPlaceError` for a range that needs a new run, apart from a
  range that is no range.
- `defineSpot` refuses two ranges of which no pair of hands can be held together, which
  solved to NaN before.
- A warm start into a new run copies about nine times faster (4.7 s to 0.5 on a 265 MiB
  blueprint), the same values bit for bit.

### Startup

- Less stands between a call and solving. Defining the spot, creating the run and the first
  iteration's extra cost took 727 ms on the bench flop on 4 threads and take 244, or 65 for a
  later solve of the same board and hands; 582 and 233 (75) on one thread; 1456 and 584 (436)
  for the Lite blueprint on As Kh 7d. Results are the same, bit for bit.
- The per-hand tables are built about five times faster, and the last set is kept for a spot
  defined again on the same board with the same hands. `releaseSetupCache()` lets it go.
- In Node a run's threads start beside its setup, and when it closes replacements start and
  wait 30 seconds for the next run; `enableThreads(n)` starts them ahead and keeps that many.
- The engine's storage is written once before the first iteration, a share a thread, instead
  of being mapped by every thread at once during it.

### Lite for a range slider: `openLite`

- `openLite(spot, options)` solves the Lite blueprint as `solveLite` does and keeps it live.
  `session.setRange(player, range)` changes a range in place and settles the blueprint again
  from where it stands; `session.refine(n)` runs more iterations while the slider is at rest;
  `session.current` is the `LiteSolution`, `resolve` included.
- On issue #47's betting, 4 threads, five moves of out of position's range settled in 95 s
  against 163 for five `solveLite` calls on As Kh 7d, 69 against 103 on Ts 9s 4h and 27 against
  52 on Ks 9s 4s: 0.31–0.61× the time for two hand classes added or dropped, 0.66–0.92× for a
  third of the range dropped. It ended less exploitable than `solveLite` in 11 moves of 15, and
  0.6–1.8% of pot more on the monotone flop's three moves that dropped hands.
- `oopReserve` and `ipReserve` on a spot keep storage for hands a range does not hold yet, so
  they can be added. With nine classes in reserve an iteration cost 27–42% more and the first
  solve took 20–52% longer.
- `run.setRange(player, range, { resume })` is the same change on any run, exact solves
  included: about 0.02 ms a call, nothing built or copied, where a `warmStart` into a new run
  costs about two iterations of the spot. It keeps the regrets and resumes the iteration count
  (from 10, `RANGE_RESUME`; `openLite` resumes from 30, as chance sampling was unstable at 10).
  The range must keep the suit symmetries the spot folds runouts by; runout buckets stand.
  A CFR+ run is refused.
- `runToStop(run, options)` runs a live run as `solve` runs its own: to the iteration cap, the
  target or the settle stop.

### `compressRanges` on a spot that starts on the turn or the river (issue #158)

- `compressRanges(spot)`, and Lite's option of the same name, take a board of four or five cards
  with the ranges the players hold there; before, any board but a flop was refused. A turn is
  matched on its board and each river that can follow. A river is also matched on what the other
  player's hands face: how much of the range beats each, ties it and loses to it.
- The default tolerance past the flop is 0.005. Under Lite on four turns (270–497 combinations a
  side, 4 threads) that settled in 0.6–0.8 s against 1.3–2.4, in 3–4 MiB against 6–11, the root
  play 1.2–1.9 points from Lite's on the full ranges, where two Lite solves were 0.6–2.6 apart.
  At 0.01 it was 1.1–7.8 points off.
- On a river there is nothing to save: Lite took 0.1 s on the full ranges.
- The vendored compressor is poker-rangecompress 0.2.0. A flop compresses as before.

## 0.5.0-beta.1

The second beta of 0.5.0 (`npm install poker-flopsolve@beta`): everything since 0.5.0-beta.0.

### Lite: compress the ranges first (issue #156)

- `solveLite` and `liteConfig` take `compressRanges` (off by default): before the blueprint is
  solved, each range keeps the fewest of its combinations, re-weighted, whose equity
  distributions on this flop's boards stay within a tolerance (default 0.01) of the full
  range's. `compressRanges(spot)` does the same on its own.
- For wide ranges. A button open against a big-blind call (433–518 combinations a side) on 4
  threads settled in 40.6 s against 87.6 on As Kh 7d, 31.2 against 62.1 on Ts 9s 4h and 16.5
  against 27.3 on Ks 9s 4s, in 0.42–0.72× the storage, with the root play 1.2–2.7 points from
  Lite's on the full ranges, where two Lite solves of the full ranges were 1.8–3.0 apart.
- On narrow ranges it gains little and can lose. The bench ranges, about 200 combinations a side:
  As Kh 7d settled in 16.0 s against 21.5 (135 MiB against 173), Ts 9s 4h in 8.6 against 12.7 (91 against 122), and Ks 9s 4s in 7.8 against 6.6 (57 against 47). Dropping combinations breaks the
  symmetries that fold boards together.
- It keeps how the range plays, not what one combination does: the blueprint and its re-solves
  hold a strategy only for the combinations kept.
- The compressor is poker-rangecompress, vendored as `src/vendor/range-compress.js` (JavaScript
  with its WebAssembly kernels embedded; the package still has no dependencies). It adds about
  60 kB to the bundle, before minifying.

### Lite's exploitability in the full game (issue #154)

- `exploitabilityInExact(lite, exact)` measures how exploitable a Lite solve's play is in
  the caller's full game. It copies Lite's strategy onto a run of the full spot wherever
  Lite has the decision, keeps that run's own play below the sizes and raises Lite cut, and
  returns the exploitability as a % of the pot.
- The benchmark page's Accuracy box, after a Lite solve, offers "Measure against Exact"
  when the full game fits in the memory left beside it. It solves Exact to the form's
  target and shows Lite's exploitability with Exact's own beside it.

### Faster: engine threads share out boards (issue #133)

- On the WebAssembly engine, threads take the split round's boards off a shared queue,
  costliest first, instead of fixed slices. `solveLite` on As Kh 7d settled about 15% sooner
  on 2 and 4 threads in headless Chromium (57.9 → 49.3 s, 33.7 → 28.1 s), turn re-solves
  12–19% sooner; the slowest thread now walks within 1% of the mean, from about 13%.
- A threaded solve on the WebAssembly engine is now bitwise the same at every thread count
  from two up, not only at a fixed count. One thread still agrees with it only to floating
  point, as before.
- `npm run bench:lite` (issue #133) times `solveLite` phase by phase in any browser, at each
  thread count, and reports each thread's walking time.

### Changed: EV is a percentage of the pot (issue #130) — breaking

- `Solution.ev(player)` and `Solution.handEvs(player)` now report the player's **share of the
  pot, in percent**, instead of chips against a half-pot baseline. Folding (or losing every
  showdown) is 0%, winning the pot uncontested is 100%, and `ev(0) + ev(1)` is 100. On Ks 9d 4c
  with a 60 pot, `12.5 / −12.5` chips now reads `70.8 / 29.2`%.
- The pot is the spot's starting pot (`SpotConfig.pot`), exposed as `Solution.evPot`. Convert
  back with **old chips = `pct / 100 × pot − pot / 2`**, or read `Solution.evChips(player)`
  and `Solution.handEvsChips(player)`, which return the old numbers.
- New `SpotConfig.evPot` (default `pot`). `Solution.subgameAt` sets it to the original spot's,
  so `resolveSubgame` and `LiteSolution.resolve` (nested too) report in % of the **original
  flop pot**: values read the same way down a hand, and folding at a subgame's root reads below
  0 (the chips put in on earlier streets). For those, convert with the flop pot, `evPot`.
- Applies to the presets' solutions (`solveLite`, `largeTree`), subgame solutions, the CLI and
  the UI readout, which now show `%`.
- Unchanged, still chips on the half-pot baseline: `Solver.valuesAt`, `pairValuesAt`,
  `rootValues`, `handEvs` on the `Solver`, regrets, `ResolvedSubgame.alternative` / `entered`,
  and `exploitability()` (`exploitabilityPercent()` stays % of the spot's own pot).
- napkinpoker: `tools/bench/flopsolve/flop-vs-pfrs.mjs` reads `ev()` and needs `evChips()` to
  keep its chip numbers, or a `%` label; `src/villain/flopsolve-villain.js` reads `valuesAt`,
  which is unchanged.

## 0.5.0-beta.0

The first beta of 0.5.0, published under npm's `beta` tag (`npm install poker-flopsolve@beta`); `latest` stays 0.4.1 until 0.5.0. A minor release. Every approximation below is opt-in and off by default. The README's
[Choosing an approximation](README.md#choosing-an-approximation) maps goals to presets, and its
[options inventory](README.md#options-inventory) gives each option's status and measured cost.

### Presets (issue #115)

- `solveLite` / `litePreset` (#100): the flop as given, one turn and river size, shared river
  storage, runout buckets, sampling, a stop on the root play, and turn re-solves on demand.
- `largeTree` (#102, in `poker-flopsolve/wasm-storage`): `thinSizes`, 16-bit storage on the
  WebAssembly engine and sampling. The round's target tree, 17.2 GiB at 32 bits, fits in 1.97 GiB.
- Both report what they changed: `LiteSolution.changes`, `LitePreset.changes` and
  `LargeTree.changes` list the sizes cut by street and player, the rounds simplified, and every
  setting set or dropped (#115).
- `litePreset` (#115) returns what `solveLite` solves, without solving it, for a page that steps its
  own run.
- `keepBudget` on `solveLite` / `litePreset` (#113): keep the most-reached flop lines unshared within
  a storage budget, ranked on a short solve of the blueprint with its river checked down
  (`checkedDown`, `keepWithin`); `LiteSolution.kept` lists them. On issue #47's flops, 150 MiB at 16
  bits cut a turn re-solve's best-response gain by a third to a half, root play unchanged.
  With a budget, `settle`'s tolerance defaults to 0.005, not 0.01 (#123): the kept lines' turn
  ranges go on improving after the root play settles, and stopping later cut the re-solve gain by
  15–28% more for out of position (3–34% in position) for 16–32% more time on 4 threads.

### New opt-ins since 0.4.1

Spot settings (`SpotConfig`):
- `shareHistories`: one river storage for betting lines that meet (#49).
- `shareHistories.keepLines`, with `linesWithin` and `turnLineReach`: keep the most-reached lines
  unshared within a memory budget (#101).
- `thinSizes`: one size at most decisions, the shape that adaptive growth found (#51).
- `removeActions`: cut named bets, raises and shoves from the tree (#51).
- `compactStorage`: 8-bit regrets and strategy sums (#50).

Solve settings (`SolveOptions`):
- `approximations.chanceSampling`: deals sampled with baselines (#25). It runs on worker threads
  (#99) and over 16-bit storage (#102).
- `approximations.coarseStart`: start from a bucketed copy of the spot (#24).
- `approximations.currentProfileEv`, with `Solution.handEvs`: EVs under the current profile (#35).
- `warmCards`: warm starts between flops (#30).
- `settle`, with `trackSettle`, `rootPlay`, `rootPlayMovement` and `rootPlayNodes`: stop when the
  root play stops moving (#100).
- `wasmStorage` (`poker-flopsolve/wasm-storage`): 16-bit and compact storage on the WebAssembly
  engine, threads included (#84).

Re-solving and threads:
- `resolveSubgame`: re-solve a node's subgame at new betting (#47).
- `poker-flopsolve/threads`, with `enableThreads`: worker threads in the browser (#29).

### Removed before release (#125)

These were added during 0.5.0's development, measured as dead ends in #115, and removed before the
release, so no published version has them. Their numbers are in
[docs/APPROXIMATIONS.md](docs/APPROXIMATIONS.md#removed-before-050-125).

- `SpotConfig.lineRunouts` (#53): more costly than the presets, JavaScript only, and it refused
  sharing, compact storage, sampling and coarse starts. Use `largeTree` or `thinSizes`.
  `Spot.resolveBoard` lost its `node` argument with it.
- `ShareHistories.spr`, `.fromRound` and `.weighting` (#49): measured lossier than they save.
  Sharing covers the river alone, exact meetings, weighted by reach.
- `ResolveOptions.gadget` and `.values`, the `Gadget` type and `ResolvedSubgame.gadget` / `.gifts`
  (#47): the safe gadgets measured worse than plain re-solving. `measure: true` still reports
  `alternative` and `entered`.

### Documentation

- The README opens its performance part with a goal table and an options inventory. The per-option
  sections are an appendix.
- The record of approximations measured and left out moved from the `Approximations` type to
  [docs/APPROXIMATIONS.md](docs/APPROXIMATIONS.md) (#115).
- Both presets are in the options pair matrix and scored against napkinpoker's reference solves in
  `npm test` (#103, #115). Those fixtures moved to the private napkinpoker repository (#119); the
  scoring test skips where they are absent.
