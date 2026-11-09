# Memory-lever combinations (issue #102)

Which levers stack to fit the round's target T into 1–2 GiB, solving in minutes. T is
As Kh 7d, pot 55, stack 975, bench ranges, 0.33 / 0.75 / 1.5 pot, a 0.75 raise and all-in,
three aggressions, every street (`bench/adaptive/spots.ts`): 17.2 GiB at 32 bits. T₀ is the
same with all-in as the only raise and two aggressions, 5.8 GiB.

| script | what it does |
|---|---|
| `spots.ts` | the spots, and combinations named by `+`-joined levers: `thin`, `share`, `i16`, `compact`, `b3`, `sample`, `js` |
| `census.ts <spot> <combination>...` | projected storage at 32 bits, 16 bits and compact, no solve |
| `measure.ts <spot> <combination> [checkpoints]` | solves on 4 threads in Node; at each checkpoint, exploitability, root-play loss and per-hand root EV error against `REF`, and peak RSS. `SAVE=1` saves its root data as a reference |
| `queue.sh "<job>" ...` | runs `measure.ts` jobs one at a time |
| `browser.ts <spot> <combination> [workers] [iterations] [sampling]` | s/iteration and the renderer's peak RSS in headless Chromium |
| `napkin.ts <combination> [iterations] [spots]` | root-play loss on napkinpoker's spots against their stored postflop-solver EVs (#87) |

Every run was on a 4-core container, one at a time with nothing else running, and stayed
under 20 minutes. `out/` holds every log and result.

## Measures

- **Root-play loss:** for OOP at the root, and for IP after a check where the reference
  has it, each hand's best reference action EV minus the reference EV of the mix this solve
  plays. It's weighted by the reference's reach times the opponent mass the hand doesn't
  block, in % of pot (as #85 measured it). This is the headline.
- **Settled:** the first checkpoint from which OOP's loss stays within 0.02% of pot of
  its value at the last checkpoint. It is relative to the run's own end.
- **EV error:** per-combination root EV against the reference, % of pot: the range-weighted
  mean, and the max over combinations weighing at least 1%.
- **Exploitability:** in the solve's own game. With `b3`, the bucketed game.

## T, against `thinSizes` at 32 bits

There is no exact T reference: one would take hours. The reference is the least lossy
combination, `thinSizes` alone at f32 (2.9 GiB). It ran 600 iterations to 0.154% of pot, in
812 s, at 3.18 GiB peak (`out/T-thin.root.json`). So these numbers measure what each
lever adds on top of `thinSizes`, not `thinSizes`' own cost; T₀ measures that, below. The
reference's own mix loses 0.032 / 0.019% at its own values: that is the floor.

| combination | storage GiB | peak RSS GiB | s/it | settled | end | exploitability % | loss OOP / IP | EV error OOP / IP (max) |
|---|---|---|---|---|---|---|---|---|
| thin+i16 | 1.47 | 1.75 | 1.56 | 317 s | 600 it, 938 s | 0.133 | 0.031 / 0.020 | 0.04 / 0.02 (0.25 / 0.21) |
| thin+compact | 1.02 | 1.28 | 1.95 | 396 s | 500 it, 977 s | 0.344 | 0.033 / 0.020 | 0.03 / 0.06 (0.26 / 0.31) |
| thin+b3+i16 | 0.86 | 1.12 | 0.97 | 244 s | 600 it, 580 s | 0.124 | 0.028 / 0.020 | 0.37 / 0.32 (2.2 / 2.0) |
| thin+share+i16 | 0.42 | 0.69 | 1.70 | 525 s | 600 it, 1022 s | 4.86 | 0.048 / 0.019 | 0.51 / 0.48 (2.5 / 2.6) |
| thin+share+b3+i16 | 0.25 | 0.51 | 1.08 | 268 s | 600 it, 645 s | 5.41 | 0.048 / 0.020 | 0.69 / 0.98 (5.1 / 5.1) |
| **thin+i16+sample** (`largeTree`) | 1.47 | 1.97 | 0.25 | **155 s** | 1600 it, 398 s | 0.348 | 0.031 / 0.020 | 0.05 / 0.05 (0.31 / 0.38) |
| thin+compact+sample | 1.02 | 1.48 | 0.28 | 168 s | 1600 it, 444 s | 0.529 | 0.031 / 0.020 | 0.05 / 0.09 (0.43 / 0.81) |
| thin+b3+i16+sample | 0.86 | 1.25 | 0.14 | 87 s | 1600 it, 228 s | 0.384 | 0.031 / 0.020 | 0.20 / 0.17 (2.3 / 2.3) |

Census (`out/census-T.txt`, GiB f32 / i16 / compact):

| combination | f32 | i16 | compact |
|---|---|---|---|
| exact | 17.2 | 8.7 | 5.9 |
| thin | 2.93 | 1.49 | 1.04 |
| share | 2.92 | 1.48 | 1.01 |
| thin+share | 0.85 | 0.44 | 0.31 |
| thin+b3 | 1.72 | 0.87 | 0.61 |
| thin+share+b3 | 0.50 | 0.26 | 0.18 |

Sharing without `thinSizes` saves storage but no compute, so on T it runs at the full
tree's cost. On T₀ that's 2.7 s an iteration where the thinned tree takes 0.6, so it
wasn't run on T.

### Chromium

Headless Chromium, 4 threads (`poker-flopsolve/threads`, `wasmStorage`). The renderer's
peak RSS covers the page, its WebAssembly memory and its workers (`out/browser.jsonl`).
Sampled rows time their first 60 iterations after a warm-up; unsampled ones 20.

| combination | s/it | renderer peak |
|---|---|---|
| thin+i16 | 1.48 | 1689 MiB |
| thin+compact | 1.89 | 1229 MiB |
| thin+i16+sample | 0.23 | 1910 MiB |
| thin+compact+sample | 0.27 | 1451 MiB |
| thin+b3+i16+sample | 0.14 | 1170 MiB |

## T₀, against the exact solve

The reference is #51's exact T₀ solve (`bench/adaptive/results/rainbow-T0.json`: 561
iterations, 0.22% of pot, OOP's root actions only). It was reused rather than rebuilt,
since a new one would have to stop at about 20 minutes and be less converged. So this
yardstick includes what `thinSizes` costs against the full tree.

| combination | storage GiB | peak RSS GiB | s/it | settled | end | exploitability % | loss OOP | EV error OOP / IP (max) |
|---|---|---|---|---|---|---|---|---|
| thin (f32) | 1.29 | 1.55 | 0.60 | 151 s | 400 it, 242 s | 0.214 | 0.038 | 1.45 / 1.64 (5.7 / 6.4) |
| thin+share (f32) | 0.57 | 0.85 | 0.66 | 166 s | 400 it, 264 s | 4.40 | 0.052 | 1.47 / 2.23 (7.5 / 7.2) |
| share (f32) | 1.20 | 1.46 | 2.73 | 820 s | 400 it, 1093 s | 8.05 | 0.042 | 0.57 / 0.87 (1.6 / 2.8) |
| thin+i16 | 0.65 | 0.92 | 0.68 | 139 s | 600 it, 411 s | 0.158 | 0.038 | 1.42 / 1.55 (5.5 / 6.4) |
| thin+i16+sample | 0.65 | 1.02 | 0.11 | 106 s | 1600 it, 168 s | 0.522 | 0.044 | 1.48 / 1.94 (5.4 / 6.3) |
| thin+compact+sample | 0.44 | 0.81 | 0.13 | 129 s | 1600 it, 207 s | 0.627 | 0.046 | 1.53 / 2.03 (5.5 / 6.4) |
| thin+b3+i16+sample | 0.38 | 0.67 | 0.07 | 65 s | 1600 it, 103 s | 0.502 | 0.047 | 1.48 / 2.20 (5.6 / 6.1) |

## C0: `thinSizes` with `shareHistories`

Rerun on the current solver, the first three rows of the T₀ table. The pair stalls at 4.4%
exploitability, as #51 saw. It's sharing's own imperfect-recall floor, not a bug:

- **Sharing alone stalls higher.** It sits at 8%, so the floor belongs to sharing, and
  thinning lowers it.
- **Not the fixed bugs.** #86/#88/#94 fixed compact and 16-bit storage; this run is 32-bit,
  which already discounted a shared block once an iteration.
- **Not mismatched rivers.** `shareHistories` shares only rivers whose subtrees are
  identical, amounts and payoffs included, so the rivers `thinSizes` made different simply
  don't share.
- **Not a thread race.** The threads split by runout, so a shared block is always one
  thread's. 1 and 4 threads differ only by float summation order, as unshared runs do.
- **It converges, it doesn't oscillate:** 4.71, 4.51, 4.45 and 4.40% from 200 to 400
  iterations, with the root strategy moving less at each checkpoint.

The root play barely notices: it loses 0.052% of pot against 0.038% thinned alone.
