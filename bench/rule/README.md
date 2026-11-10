# DCFR schedules under Lite (issue #133)

Logs of `bench/lite/measure.ts rainbow <variant> 4` with `RULE=none CAP=800 RESOLVES=0`, for the
schedule variants `alpha=`, `gamma=` and `floor` (DCFR+). The plumbing is at commit `f801432`, and
the conclusions are in `docs/APPROXIMATIONS.md` under "Other DCFR schedules under Lite (#133)".

- `rainbow-4t.log`: today's rule, DCFR+ at γ 2, 3 and 4, γ 2 and 4, and α 1 and 2.
- `rainbow-4t-gamma.log`: γ 5, 6 and 8, and today's rule again (the same numbers: the runs are
  deterministic).
