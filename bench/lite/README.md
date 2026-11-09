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

The results are in `src/lite.ts` (`solveLite`'s notes), the README's "Lite mode" and
the `Approximations` notes in `src/index.ts`.

`out/` holds what they printed:

- `trim-*.log`: the speed trims, one at a time, on rainbow (`RULE=none`, 700
  iterations, rules tabulated).
- `acc-*.log`, `browser-*.log`, `t0-*.log`, `napkin-base.log`: the final defaults.
- `trimmed/`: the same runs from the round when `noDonk` and a flop cap of two
  aggressions were defaults, before the two-tone re-solves showed what they cost.
- `diag-two-tone-*.log`: that round's diagnostics. Their names describe the defaults
  of the time: `donk` and `flop3` turned those trims off, so `donk,flop3` is today's
  default, and `nosample-4t` and `unshared,nosample-4t` still had both trims on.
- `*.json`: the scripts' structured output, overwritten by later runs of the same name.

The re-solve warm-start numbers in `trimmed/acc-rainbow.log` come from a prototype
since removed (see the `Approximations` notes).
