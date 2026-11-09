#!/usr/bin/env bash
# Runs bench/combos/measure.ts jobs one at a time (timing runs must not overlap).
#   bench/combos/queue.sh "<spot> <combination> [checkpoints]" ...
# Environment for every job passes through (REF, EXPL, MAX_SECONDS, SAVE).
cd "$(dirname "$0")/../.."
# Split each job into words, never expand globs.
set -f
for job in "$@"; do
	set -- $job
	log="bench/combos/out/$1-$2${TAG:-}.log"
	echo "== $job" | tee "$log"
	node --import tsx bench/combos/measure.ts "$@" 2>&1 | tee -a "$log"
done
