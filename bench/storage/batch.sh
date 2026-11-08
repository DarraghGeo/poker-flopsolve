#!/bin/bash
# Run variants of one spot, N at a time: batch.sh <spot> <workers> <checkpoints> <parallel> variant...
spot=$1; workers=$2; checks=$3; par=$4; shift 4
mkdir -p bench/storage/logs
printf '%s\n' "$@" | xargs -P "$par" -I{} sh -c "node --import tsx bench/storage/run.ts $spot {} $workers $checks > bench/storage/logs/$spot-{}-w$workers.log 2>&1; echo done {}"
