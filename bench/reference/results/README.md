## Cross-check: exact solves against the stored regrets

Regret error = |(EV(a) − EV(best)) ours − stored| per hand, reach-weighted, % of the node pot. "Played" weights each action by the larger of the two solvers' probability of it; "all actions" includes actions neither plays (off-path values).

| Spot | Board | Texture | Pot | f32 GiB | Iterations | Exploitability | Time | Flop played: mean / worst node | Turn played: mean / worst node | All actions: flop / turn mean | Root loss at stored EVs, OOP / IP (stored strategy's own) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| f01 | 7h 5c 7s | rainbow, paired | SRP | 2.25 | 440 | 0.300% | 698 s | 0.024 / 0.059 | 0.017 / 0.056 | 0.59 / 2.04 | 0.105 / 0.023 (0.109 / 0.016) |
| f03 | 7c 6s Jc | two-tone | 3BP | 0.51 | 140 | 0.262% | 61 s | 0.014 / 0.035 | 0.020 / 0.064 | 0.23 / 0.25 | 0.069 / 0.040 (0.069 / 0.061) |
| f05 | 5s Ts Ac | two-tone | SRP | 2.03 | 410 | 0.299% | 555 s | 0.021 / 0.078 | 0.050 / 0.158 | 0.48 / 3.86 | 0.000 / 0.013 (0.000 / 0.017) |
| f15 | As Kc 3d | rainbow | 3BP | 0.89 | 140 | 0.276% | 92 s | 0.041 / 0.153 | 0.021 / 0.037 | 0.37 / 0.77 | 0.064 / 0.099 (0.062 / 0.109) |
| f23 | 2d 3h 2c | rainbow, paired | 3BP | 0.57 | 160 | 0.278% | 79 s | 0.019 / 0.042 | 0.021 / 0.062 | 0.33 / 0.66 | 0.024 / 0.086 (0.026 / 0.083) |
| f79 | 4s 7c 4c | two-tone, paired | 3BP | 0.54 | 130 | 0.278% | 59 s | 0.017 / 0.072 | 0.023 / 0.096 | 0.34 / 0.23 | 0.044 / 0.022 (0.037 / 0.027) |
| f85 | 5s Js 6s | monotone | SRP | 0.80 | 390 | 0.298% | 249 s | 0.018 / 0.055 | 0.019 / 0.031 | 0.18 / 1.21 | 0.001 / 0.011 (0.003 / 0.008) |

## Each option on the napkinpoker sample

EV lost at the stored per-action EVs, % of the node pot, at as many iterations as the exact solve took to 0.3% (times the Iterations column). Root: OOP at the flop root / IP after a check. Flop and turn: mean over the scored nodes. Means over the spots.

| Option | Spots | Iterations | Storage vs exact | Time vs exact | Nodes not in its tree | Root loss OOP / IP | Flop nodes | Turn nodes | Re-solved turns | True exploitability, % of pot |
|---|---|---|---|---|---|---|---|---|---|---|
| exact | 3 | 1.0× | 1.00× | 1.00× | 0 of 61 | 0.059 / 0.054 | 0.030 | 0.031 | — | 0.27 |
| shareHistories | 3 | 1.0× | 0.40× | 0.96× | 0 of 61 | 0.061 / 0.068 | 0.034 | 0.041 | — | 1.89 |
| compactStorage | 3 | 1.0× | 0.37× | 1.31× | 0 of 61 | 0.063 / 0.080 | 0.045 | 0.039 | — | 0.63 |
| thinSizes | 3 | 1.0× | 0.74× | 0.63× | 15 of 61 | 0.067 / 0.294 | 0.084 | 0.048 | — | 0.22 |
| runoutBuckets | 3 | 1.0× | 1.00× | 0.95× | 0 of 61 | 0.059 / 0.054 | 0.030 | 0.031 | — | 0.27 |
| chanceSampling | 3 | 1.0× | 1.00× | 0.21× | 0 of 61 | 0.171 / 0.172 | 0.130 | 0.397 | — | 8.64 |
| coarseStart | 3 | 1.0× | 1.00× | 0.96× | 0 of 61 | 0.059 / 0.054 | 0.030 | 0.031 | — | 0.27 |
| lineRunouts | 3 | 1.0× | 0.73× | 1.58× | 0 of 61 | 0.097 / 0.072 | 0.251 | 0.234 | — | 5.94 |
| i16 | 3 | 1.0× | 0.52× | 1.10× | 0 of 61 | 0.059 / 0.067 | 0.033 | 0.035 | — | 0.37 |
| resolveSubgame | 3 | 1.0× | 0.59× | 0.65× | 0 of 61 | 0.062 / 0.073 | 0.057 | 0.107 | 0.053 | — |
| runoutBuckets+i16 | 3 | 1.0× | 0.52× | 1.09× | 0 of 61 | 0.059 / 0.067 | 0.033 | 0.035 | — | 0.37 |
| runoutBuckets+resolveSubgame | 3 | 1.0× | 0.59× | 0.67× | 0 of 61 | 0.062 / 0.073 | 0.057 | 0.107 | 0.053 | — |
| shareHistories+runoutBuckets | 3 | 1.0× | 0.40× | 1.01× | 0 of 61 | 0.061 / 0.068 | 0.034 | 0.041 | — | 1.89 |
| shareHistories+chanceSampling | 3 | 1.0× | 0.40× | 0.21× | 0 of 61 | 0.128 / 0.122 | 0.090 | 0.274 | — | 8.30 |
| shareHistories+compactStorage | 3 | 1.0× | 0.15× | 1.33× | 0 of 61 | 0.067 / 0.083 | 0.041 | 0.047 | — | 2.08 |
| thinSizes+shareHistories | 3 | 1.0× | 0.35× | 0.69× | 15 of 61 | 0.071 / 0.288 | 0.084 | 0.049 | — | 2.07 |
| lineRunouts+runoutBuckets | 3 | 1.0× | 0.73× | 1.56× | 0 of 61 | 0.097 / 0.072 | 0.251 | 0.234 | — | 5.94 |
| chanceSampling, 2× iterations | 3 | 2.0× | 1.00× | 0.38× | 0 of 61 | 0.086 / 0.086 | 0.052 | 0.093 | — | 2.26 |
| chanceSampling, 4× iterations | 3 | 4.0× | 1.00× | 0.69× | 0 of 61 | 0.057 / 0.056 | 0.030 | 0.033 | — | 0.60 |

The stored strategy's own loss at the same nodes (noise floor): root 0.056 / 0.065, flop 0.031, turn 0.026. Time for blueprint + resolveSubgame includes the re-solves. Flop and turn means are over the nodes the option's tree holds.
