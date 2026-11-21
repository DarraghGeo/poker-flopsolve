# Startup

What a solve costs before it is solving.

| script | what it does |
|---|---|
| `measure.ts [dist,...] [case,...] [prepare]` | each case in new Node processes: package load, `defineSpot`, `createRun`, the first iteration against the second, cold (first in a process) and hot (a later spot of the same board and hands) |
| `grow.js [workers]` | a run growing for two hand classes a range adds against a run storing every hand ahead: first solve, the change, the re-solve (`out/grow-1t.log`) |
| `child.js` | one such process; plain JavaScript, so the threads a run starts load no TypeScript loader |

`out/node-4t.log` compares a build of `staging` from before the startup work with the build
after it; both are within 0.5.0-beta.2. The results are in the README's "Startup".
