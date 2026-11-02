#!bash

# Started LAST, after 09_env.sh and 10_config.sh have written this boot's layout and
# settings into the files /etc/bashrc sources.
#
# A service takes its environment from the shell `service start` opens for it, and
# that shell builds its environment from /etc/bashrc — not from the deno process.
# /etc/bashrc lives in the database and survives restarts, so starting services
# before `config publish` hands every one of them the *previous* boot's settings,
# silently and with no error anywhere.
#
# Nothing here needs a service running, so the cost of going last is nothing.

echo "Starting enabled services..."
service start-all
