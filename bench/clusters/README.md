# Runout clusters experiment (issue #23)

Potential-aware turn/river card clustering, measured in the real game. The prototype
(`src/clusters.ts`, `SpotConfig.runoutClusters`) lives only in the commit that added this
folder; it was removed afterwards because it did not beat the baseline. See the comment on
`Approximations` in `src/index.ts` for the verdict.

From the repository root, on that commit:

    node --import tsx bench/clusters/reference.ts           # exact references, 0.025% of pot
    LIMIT=32 node --import tsx bench/clusters/sweep.ts       # time vs error, every config
    node --import tsx bench/clusters/browser.mts             # browser/node speed factors
    python3 bench/clusters/analyse2.py                       # errors at 15 s browser time

`out/` holds the measured results.
