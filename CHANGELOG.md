# Changelog

## Unreleased

Not in 0.5.0-beta.0, which was already published: this lands in the next beta or in 0.5.0.

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
