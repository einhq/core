# audit-purger — keep the audit trail and the access log bounded.
#
# Nearly all of the trail is the writes of pipeline runs: every node an import or a model change
# derives, about ninety records for each indexed photo, against a few for a person's change. Those
# go after CFG_AUDIT_PIPELINE_RETENTION_DAYS, the rest after CFG_AUDIT_RETENTION_DAYS, and the
# access log's sign-ins and downloads after CFG_ACCESS_LOG_RETENTION_DAYS; 0 keeps them. The
# database reuses the space a purge frees for new records rather than giving it back to the disk,
# so a purge stops the trail growing instead of shrinking it. Twice a day, and the first pass runs
# at boot.
echo audit-purger: starting
while true; do
  if [ "${CFG_AUDIT_PIPELINE_RETENTION_DAYS:-14}" -gt 0 ]; then
    echo "audit-purger: pipeline runs: $(audit-purge --pipeline --older-than "${CFG_AUDIT_PIPELINE_RETENTION_DAYS:-14}d")"
  fi
  if [ "${CFG_AUDIT_RETENTION_DAYS:-0}" -gt 0 ]; then
    echo "audit-purger: every write: $(audit-purge --older-than "${CFG_AUDIT_RETENTION_DAYS}d")"
  fi
  if [ "${CFG_ACCESS_LOG_RETENTION_DAYS:-365}" -gt 0 ]; then
    echo "audit-purger: access log: $(access-log-purge --older-than "${CFG_ACCESS_LOG_RETENTION_DAYS:-365}d")"
  fi

  sleep 43200
done
