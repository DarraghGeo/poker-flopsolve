# Nested subgame re-solving (issue #47)

A blueprint keeps the target spot's full flop betting (0.33, 0.75 and 1.5 pot, a 0.75 raise,
three raises, all-in) and simplifies the turn and river. Each scripted measurement compares it
with the full tree, solved as a reference. The spots are in `spots.ts`.

| script | what it does |
|---|---|
| `estimate.ts` | memory estimates for the full tree and each blueprint, on both boards |
| `reference.ts <board> T i16` | solves the full tree to 0.3% of pot on four threads; saves root EVs, the whole strategy, and the subtree below 15 turn nodes (5 most-reached flop lines × 3 turns). `NESTED_LOAD=1` cuts the subtrees from the saved strategy again without solving |
| `run.ts <board> <variant> [iterations] [gadgets]` | solves a blueprint; reports its root EV error and size agreement against the reference, then re-solves each saved turn node with each gadget and measures the opponent's best-response gain under the reference ranges |
| `sizes.ts <board> <variants...>` | the cost of the blueprint's root size choices, valued at the reference's per-action EVs |
| `browser.ts <board> <variant>` | blueprint and re-solve wall times in headless Chromium on 1 and 4 threads |

`out/` holds what they printed on the monotone board Ks 9s 4s:

- `ref-monotone-T.solve.log`: the reference solve, 950 iterations to 0.093%. Its subtree lines
  for flop lines with a bet are wrong. They were cut before the bet-size matching fix and read
  130–180% local exploitability.
- `ref-monotone-T.cut.log`: the same subtrees cut again after the fix, at 0.04–0.57%.
- `run-*.json`, `run-monotone-*.log`: one per blueprint variant. `-ev` uses blueprint values
  instead of best responses for the gadgets.
- `sizes-monotone.log`, `browser-*.log`: the other two scripts.

The rainbow board As Kh 7d was not run. Its full tree needs 8.9 GB at i16, which only the
JavaScript engine can hold, for an estimated 2–3 hours.
