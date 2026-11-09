#!/bin/sh
# Issue #103: every variant on each spot given, one solve at a time. Logs to results/.
cd "$(dirname "$0")/../.."
for id in "$@"; do
	node --import tsx bench/reference/options.ts "$id" >> "bench/reference/results/options-$id.log" 2>&1
done
