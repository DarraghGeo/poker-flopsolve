# napkinpoker reference solves

Seventy flops solved flop → river by an independent solver, imported as fixtures for scoring approximations on every board texture (issue #87). Load them with `../napkinpoker.ts`.

## Where they come from

- **Repo:** the owner's napkinpoker, commit `16df4c3` (2026-11-08).
- **Configs:** `tools/bench/short-allin/spots/fullhand_{a,b}/` → `spots/`.
- **Stored cards:** `fullhand-cards.json` → `cards.json`.
- **Nodes:** `ev/fullhand_{a,b}.jsonl.gz` → `flop.jsonl.gz` and `turn.jsonl.gz`. The full export (68 MB, with every river node) stays in napkinpoker.

They were solved with postflop-solver 9d1509f through poker-huerosolver's bench `pfrs`, plus napkinpoker's short-all-in patch, which keeps the all-in for less that this solver also offers. The target was 0.3% of pot; exploitability at the end was median 0.29% and max 0.30%. Each solve covers every runout. The stored turn and river cards (`cards.json`) only choose which nodes were exported.

## The spots

70 flops: 31 two-tone, 23 rainbow, 7 paired rainbow, 6 paired two-tone and 3 monotone. Ranges are realistic and weighted (e.g. BU vs BB). There are 51 single-raised pots (5.5 bb pot, 97.5 bb behind) and 19 3-bet pots (`potType`).

Every spot has the same betting:
- the flop offers 33% and 75% of the pot; the turn and river offer 75%;
- raises go to 3× the bet faced, one raise per street;
- the all-in is offered on every street.

`toConfig` maps these to a `SpotConfig`, as napkinpoker's `tools/bench/flopsolve/flop-vs-pfrs.mjs` does. `test/napkinpoker-reference.test.ts` checks that every stored node is a node of the tree this solver builds from its config, with the same actor and the same actions at the same amounts. So both solvers solve the same game.

## The nodes

- **`flop.jsonl.gz`:** every flop decision node up to three actions in where the actor keeps at least 3% of its range. 439 nodes.
- **`turn.jsonl.gz`:** the first decision of the turn, after each stored turn card, on every flop line that reached it. 838 nodes: the roots of the turn subgames `resolveSubgame` refines.

One JSON object per line:

| Field | Meaning |
|---|---|
| `id` | Spot id, plus the turn card on the path: `f00`, `f00-5h` |
| `board` | Board at the node |
| `path` | Labels from the root. `X` check, `F` fold, `C` call, `B`/`R`/`A` bet, raise, all-in with the **within-street** amount in chips ×100; `dXX` a card dealt |
| `actor` | 0 out of position, 1 in position |
| `pot`, `facing`, `stack` | Chips: the pot including any bet faced, the amount to call, and the effective stack left |
| `reach` | Within-street reach of actor and opponent (filter `reach[1] >= 0.03` to drop lines the opponent rarely takes) |
| `actions` | The solver's action labels |
| `names` | The actor's combinations with reach, high card first (suits c < d < h < s) |
| `w` | The actor's reach per combination ×10000: the range weight at its first decision |
| `s` | Strategy `[action][combo]`, probability ×1000 |
| `ev` | EV `[action][combo]`, chips ×100; `null` where the solver gave none |

`napkinNodes()` parses all of this:
- combinations become indices, as `COMBO_CARDS`;
- `w` becomes range-weight units (÷10000);
- `s` becomes probabilities;
- `ev` becomes chips.

## Caveats

- **EVs are relative to the node.** Differences between actions for the same combination are exact: that is the regret. The absolute level follows napkinpoker's export convention, under which folding reads 0. So compare action against action, not against `Solution.handEvs`.
- **0.3% of pot is the precision.** That is fine for EV errors around a percent of the pot. It is too coarse for losses of a few hundredths of a percent. napkinpoker measured self-regret around 7.7% of the pot at nodes the actor reaches under 1% of the time.
- **Only some nodes are stored:** the flop to three actions deep, and the turn only at its first decision on two stored cards per flop. Exploitability and anything deeper need a solve of the spot itself.
