# upload-reaper — remove the uploads sent in pieces that were given up on.
#
# Each upload in the spool is a file of its own in its account's folder, written to as each piece
# arrives, so one unchanged for CFG_UPLOAD_EXPIRES_HOURS was abandoned, and the server already
# answers for it as gone. One that arrived whole is kept as long, to tell a sender that missed the
# answer where it was stored. Hourly, and the first pass runs at boot.
echo upload-reaper: starting
while true; do
  find "$UPLOAD_SPOOL_PATH" -mindepth 2 -type f -mmin +$(( ${CFG_UPLOAD_EXPIRES_HOURS:-24} * 60 )) | while read -r path; do
    rm -f "$path"
  done

  sleep 3600
done
