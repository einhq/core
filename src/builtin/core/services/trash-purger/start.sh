# trash-purger — remove trashed files for good once they have had their time.
#
# Every user's trash, the entries trashed more than CFG_TRASH_RETENTION_DAYS ago: until then
# `trash restore` brings a file back; after this pass nothing does. Twice a day is enough for a
# retention measured in days, and the first pass runs at boot.
echo trash-purger: starting
while true; do
  trash empty --all --older-than "${CFG_TRASH_RETENTION_DAYS:-30}"

  sleep 43200
done
