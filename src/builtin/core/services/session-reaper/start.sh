# session-reaper — keep /var/sessions bounded, and turn off share links that expired.
#
# Collects sessions whose cookie has lapsed and the ttys of processes that are
# gone. The first pass is also the boot sweep: `service start-all` runs this
# before the loop sleeps, and a tty from a previous process is dead by
# definition, so there is nothing to wait for.
#
# --max bounds each pass, so a backlog is cleared over several cycles instead
# of competing with live work.
#
# Hourly, by the slowest thing it collects: an HTTP session expires 12h after
# its last request, and nothing cares whether it lingers for another hour.
#
# A held share link stops granting at its expiry on its own; `share-link reap`
# takes the expired ones' entries off the nodes and their records away.
echo session-reaper: starting
while true; do
  session-reap --max 1000
  share-link reap

  sleep "${CFG_SESSION_REAP_INTERVAL:-3600}"
done
