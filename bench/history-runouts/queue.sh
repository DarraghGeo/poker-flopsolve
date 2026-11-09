#!/bin/sh
# The #53 rainbow and stacking runs, one after another (hours). Logs beside the results.
cd "$(dirname "$0")/../.."
R=bench/history-runouts/results
m() { node --import tsx bench/history-runouts/measure.ts "$@"; }
m ref --spot T0 --target 0.3 --iters 1500 > $R/T0-ref.log 2>&1
m line --spot M --buckets 3 --lines > $R/M-buckets3-lines.log 2>&1
m line --spot T0 --lines > $R/T0-lines.log 2>&1
m line --spot T0 --buckets 3 --lines > $R/T0-buckets3-lines.log 2>&1
m line --spot T0 --buckets 3 > $R/T0-buckets3.log 2>&1
echo done > $R/queue.done
