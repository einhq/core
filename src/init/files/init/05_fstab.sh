# Mounts recorded with `mount --save`. An sftp mount does not wait for its
# server here: an unreachable one is mounted anyway and connects when it
# answers, so it cannot hold up boot.
if [ -e "$ETC_PATH/fstab" ]; then
  mount -a || echo "some /etc/fstab mounts failed; continuing boot"
fi
