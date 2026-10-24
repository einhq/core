# Wire /etc/bashrc up to the configuration layers.
#
# Every shell sources /etc/bashrc at the end of Shell.open(), so a value exported from
# there is in the environment of every command, service and pipeline step — which is
# what makes a settings page able to change anything at all.
#
# `config publish` does both halves of this:
#
#   1. writes the CFG_* settings this process was launched with into /etc/environment,
#      rewritten whole, so a service restarted later from the settings page still
#      receives them and a setting the deployment stopped passing is gone;
#   2. moves the `source` lines to the end of /etc/bashrc, /etc/environment's first, so
#      /etc/config.d, /etc/config and then $HOME/.config are the last word — sourcing is
#      last-wins, and an operator's setting has to beat the deployment's.
#
# Neither settings file is created here. The -r guard in those lines means a missing one
# is skipped, and `config set` creates it on the first write — so an install where
# nothing has been changed carries no empty files and every setting is its default.
config publish
