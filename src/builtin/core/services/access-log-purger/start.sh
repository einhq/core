# access-log-purger — keep the access log bounded.
#
# Sign-ins, sign-outs, share links opened and downloads go after CFG_ACCESS_LOG_RETENTION_DAYS; 0
# keeps them. The audit trail is never purged: it is a node's whole history, and its older part is
# compressed instead. The database reuses the space a purge frees for new records rather than
# giving it back to the disk, so a purge stops the log growing instead of shrinking it. Twice a
# day, and the first pass runs at boot.
echo access-log-purger: starting
while true; do
  if [ "${CFG_ACCESS_LOG_RETENTION_DAYS:-365}" -gt 0 ]; then
    echo "access-log-purger: $(access-log-purge --older-than "${CFG_ACCESS_LOG_RETENTION_DAYS:-365}d")"
  fi

  sleep 43200
done
