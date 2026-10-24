# tmp-sweeper — remove what has been left in /tmp.
#
# /tmp is a memory mount: whatever is left there holds memory until the instance restarts — a
# picture sent to search with, above all. A file directly in it that has not changed for
# CFG_TMP_RETENTION_HOURS goes. A directory is left alone, since a mount such as dev-modules is
# one. Hourly, and the first pass runs at boot.
echo tmp-sweeper: starting
while true; do
  find "${TEMP_PATH:-/tmp}" -maxdepth 1 -type f -mmin +$(( ${CFG_TMP_RETENTION_HOURS:-24} * 60 )) | while read -r path; do
    rm -f "$path"
  done

  sleep 3600
done
