# Startup

What a solve costs before it is solving.

| script | what it does |
|---|---|
| `measure.ts [dist,...] [case,...] [prepare]` | each case in new Node processes: package load, `defineSpot`, `createRun`, the first iteration against the second, cold (first in a process) and hot (a later spot of the same board and hands) |
| `child.js` | one such process; plain JavaScript, so the threads a run starts load no TypeScript loader |

`out/node-4t.log` compares a build of `staging` at 0.5.0-beta.2 with the build after the
startup work. The results are in the README's "Startup".
