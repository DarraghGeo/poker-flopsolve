# Changelog

## 0.5.0

A minor release. Every approximation below is opt-in and off by default. The README's
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

### New opt-ins since 0.4.1

Spot settings (`SpotConfig`):
- `shareHistories`, with `spr`, `fromRound` and `weighting`: one river storage for betting lines
  that meet (#49).
- `shareHistories.keepLines`, with `linesWithin` and `turnLineReach`: keep the most-reached lines
  unshared within a memory budget (#101).
- `thinSizes`: one size at most decisions, the shape that adaptive growth found (#51).
- `removeActions`: cut named bets, raises and shoves from the tree (#51).
- `compactStorage`: 8-bit regrets and strategy sums (#50).
- `lineRunouts`: coarser runouts in chosen betting lines (#53). Deprecated in this release.

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
- `resolveSubgame`: re-solve a node's subgame at new betting, unsafe or with a safety gadget (#47).
- `poker-flopsolve/threads`, with `enableThreads`: worker threads in the browser (#29).

### Deprecated (still working in 0.5)

- `SpotConfig.lineRunouts`: more costly than the presets, and it refuses sharing, compact storage,
  sampling and coarse starts. Use `largeTree` or `thinSizes`.
- `ShareHistories.spr`, `.fromRound` and `.weighting`: measured lossier than they save. Leave them
  unset.
- `ResolveOptions.gadget` and `.values`: the safe gadgets measured worse than plain re-solving. Leave
  them unset (`'unsafe'`).

### Documentation

- The README opens its performance part with a goal table and an options inventory. The per-option
  sections are an appendix.
- The record of approximations measured and left out moved from the `Approximations` type to
  [docs/APPROXIMATIONS.md](docs/APPROXIMATIONS.md) (#115).
- Both presets are in the options pair matrix and scored against napkinpoker's reference solves in
  `npm test` (#103, #115). Those fixtures moved to the private napkinpoker repository (#119); the
  scoring test skips where they are absent.
