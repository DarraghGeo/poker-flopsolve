# Lite mode (issue #100)

`solveLite` on issue #47's betting (0.33 / 0.75 / 1.5 pot, a 0.75 raise, all-in,
three aggressions; pot 55, stack 975, the bench ranges), scored against the unshared
blueprint from `bench/blueprint-share/measure.ts <board> none` with
`BLUEPRINT_TARGET=0.05` (in `scratch/`, not committed; it takes 2–9 minutes a board).

| script | what it does |
|---|---|
| `measure.ts <board> [variants] [workers]` | Node: the blueprint to the settle rule (or `RULE=none` to a cap, tabulating rules), root play loss, per-hand EV error, turn re-solve gain and time |
| `browser.ts <board> [variants] [workers,...]` | headless Chromium: time to settle, renderer peak RSS, one timed turn re-solve |
| `t0.ts <lite\|unshared>` | against exact T₀ on As Kh 7d (`bench/adaptive/results/rainbow-T0.json`): the simplification's cost |
| `napkin.ts [count] [variant]` | napkinpoker's postflop-solver spots: root play at the stored per-action EVs |
| `user-bench*.ts` (`npm run bench:lite`) | issue #133: a cross-origin isolated page on localhost that times `solveLite` phase by phase in any browser, at each thread count, and gives a JSON report to paste back (also saved under `scratch/bench-lite/`); see `bin/bench-lite-browser.ts` |

Variants include `keep=<MiB>` (`keepBudget` through `keepWithin`, `PICK` picking
iterations, on the clock) and `i16` (16-bit storage with `wasmStorage`, the budget and
re-solves too). `browser.ts` also splits the renderer's peak by phase: the pick, the
blueprint, the re-solve (`GC=1` collects garbage after the pick, a diagnostic no caller
can do).

The results are in `src/lite.ts` (`solveLite`'s notes), the README's "Lite mode" and
`docs/APPROXIMATIONS.md` (once the `Approximations` notes in `src/index.ts`).

`out/` holds what they printed:

- `trim-*.log`: the speed trims, one at a time, on rainbow (`RULE=none`, 700
  iterations, rules tabulated).
- `acc-*.log`, `browser-*.log`, `t0-*.log`, `napkin-base.log`: the final defaults;
  `browser-*.log` after #99 made `chanceSampling` threaded.
- `trimmed/`: the same runs from the round when `noDonk` and a flop cap of two
  aggressions were defaults, before the two-tone re-solves showed what they cost.
- `diag-two-tone-*.log`: that round's diagnostics. Their names describe the defaults
  of the time: `donk` and `flop3` turned those trims off, so `donk,flop3` is today's
  default, and `nosample-4t` and `unshared,nosample-4t` still had both trims on.
- `*.json`: the scripts' structured output, overwritten by later runs of the same name.

The re-solve warm-start numbers in `trimmed/acc-rainbow.log` come from a prototype
since removed (see `docs/APPROXIMATIONS.md`).

`out/keep/` is issue #113, `keepBudget` at 150 MiB with `i16`:

- `acc-*-keep150-i16.log`: Node, 4 threads, at the settle point.
- `browser-*.log`: Chromium on 1, 2 and 4 threads; `browser-rainbow-800.log` runs to 800
  iterations.
- `diag-*.log`: what holds the remaining re-solve gain. Monotone keeps every line, so
  `unshared`, `unshared,nosample` and `keep=150,i16,nosample` separate 16 bits, sampling
  and the stop; `-800` runs to 800 iterations (`RULE=none CAP=800`).
- `mem-rainbow-*.log`: the peak by phase on 4 threads: lite as it was (`base`), `i16`
  shared, and the hybrid with the pick sampling both turn and river (`bothpick`, with and
  without `GC=1`) and the turn only (`turnpick`, what `keepWithin` does).

The `acc-*` logs and the `diag-*` logs but two-tone's used a pick sampling both rounds; it kept the same
lines as the turn-only pick on every flop, so their hybrid solves are the same.


`out/turn-stop/` is issue #123, what stop rule `keepBudget` should use (150 MiB, `i16`, 4 threads):

- `<board>-4t.log` / `.json`: `turn-stop.ts`, the blueprint to 800 iterations with the turn re-solves
  at 7 checkpoints, and where each candidate rule stops (a later root-play stop, or one that also
  waits for the kept lines' turn ranges). A rule's gain there is that of the next checkpoint, so it
  flatters rules that stop between them.
- `acc-<board>-<rule>.log` / `.json`: `measure.ts <board> keep=150,i16 4` with `RULE=<rule>`, the
  re-solve gain at the exact stop: today's 20:0.01:2 against 20:0.005:2 and 20:0.0035:2.
- `browser-<board>-20_0.005_2.log`: `browser.ts <board> keep=150,i16 4` with `RULE=20:0.005:2`,
  the rule `solveLite` now uses with `keepBudget`.
