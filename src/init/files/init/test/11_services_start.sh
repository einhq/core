# The test harness runs its own HTTP server on a random port; the network
# services would collide with fixed ports, so they stay disabled
service disable http-server || true
service disable ssh-server || true

# Started LAST, for the reason spelled out in ../primary/11_services_start.sh: a
# service's environment comes from what /etc/bashrc sources, which 10_config.sh writes, so a
# service started before it runs with the previous boot's settings.
service start-all
