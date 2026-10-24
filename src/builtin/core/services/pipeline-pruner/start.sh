# pipeline-pruner — keep the pools and the instance directories bounded.
#
# Pools first. A finished job stays as a terminal row, every trigger and every
# delegated step leaves one, and every claim and pool count reads past them, so
# /pools/triggers is the highest-volume table in the system. A purge is cheap —
# batched deletes, short transactions — and a day of history is enough to answer
# "what happened to that file", which is all anyone reads them for after the
# fact. It used to run after the instance prune, and on a first pass over a
# backlog the trigger pool sat at 1.34 M rows for the 80 minutes that took.
#
# Then instances. An instance is a node in /pipelines/instances/<pipeline>/, and
# nothing else removes the terminal ones: media-ingest reached 24,427 during a
# crawl. --keep retains the newest completions per pipeline and never touches
# running work (a running instance has no completedAt, and the retention query
# orders by it).
#
# --max is sized against the completion rate, not against caution: at 500 it was
# below what a busy pipeline completes in an hour, so the cap was never reached
# and the directory grew anyway. --budget is the other half: removing an instance
# costs ~0.3 s (a recursive unlink of the instance, its steps dir and one node
# per step), 17 pipelines at 2000 each is close to three hours, and all of it
# competes with a crawl for the database. The pipelines take turns a page at a
# time inside the budget, so a backlog converges over cycles instead. The real
# lever is the per-node write cost — ein/core#24.
#
# A pipeline that is no longer defined is retired by the same prune: all its
# instances and its directory, once its definition has stayed gone for 10 minutes.
#
# Failed instances are not pruned by the cap: `pipeline heal` runs each one
# again after a wait that grows with every try (1 h, 6 h, 24 h), and marks one
# that fails through all of them for a person. It goes first, so a failure is
# seen before anything else happens to the directory.
#
# The pools live under $POOLS_PATH.
echo pipeline-pruner: starting
pools="${POOLS_PATH:-/var/pools}"
while true; do
  # 2>/dev/null: the pools directory may not exist yet on a fresh boot, and an empty
  # substitution simply skips the loop.
  for pool in $(ls "$pools" 2>/dev/null); do
    echo "pipeline-pruner: purged $pool $(JSON_OUTPUT=1 pool purge "$pools/$pool" --older-than 24h)"
  done

  echo "pipeline-pruner: heal: $(pipeline heal --apply)"
  pipeline prune --keep 2000 --max 2000 --budget 15m

  sleep "${CFG_PIPELINE_PRUNE_INTERVAL:-3600}"
done
