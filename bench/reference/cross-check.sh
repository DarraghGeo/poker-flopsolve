#!/bin/sh
# Issue #103: the cross-check spots, one at a time. Logs to results/.
cd "$(dirname "$0")/../.."
for id in "$@"; do
	node --import tsx bench/reference/cross-check.ts "$id" 0.3 20 > "bench/reference/results/cross-check-$id.log" 2>&1
done
