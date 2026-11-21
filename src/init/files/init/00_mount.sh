# The machine's floor: the mounts, the event endpoints, and the /var skeleton.
#
# Every /var directory is created here rather than by whatever writes to it
# first, so `ls /` and `ls /var` read the same on a fresh instance as on one
# that has done some work.
mkdir -p "$BIN_PATH"
mount "$BIN_PATH" command

# /tmp is everyone's and sticky: what someone leaves there is theirs alone, to read and to remove.
mkdir -p "$TEMP_PATH"
mount "$TEMP_PATH" memory "mode=1777"

mkdir -p $VAR_DIRS

mkdir -p /dev
# Reads of /dev/null end at once and writes to it are discarded, as on Linux. Anything else
# found at the path is replaced; the mode is set on every boot, whatever an existing one has.
[ -c /dev/null ] || { rm -f /dev/null; mknode -t null /dev/null; }
chmod 666 /dev/null
# Domain events and the pipeline engine's lifecycle are the administrator's: whoever writes them
# starts pipelines, and whoever reads them hears every node they are about.
[ -e /dev/events ] || mknode -t router --as routingKey=system.events /dev/events
[ -e /dev/pipeline-events ] || mknode -t router --as routingKey=system.pipeline /dev/pipeline-events
chmod 700 /dev/events /dev/pipeline-events

[ -e "$LOGS_PATH/system" ] || mknode -t log --al routingKeys=system.logs "$LOGS_PATH/system"
truncate "$LOGS_PATH/system"

# The system log, the services' output and the pipeline instances name everyone's files, sign-ins
# and step output, so only the administrator's group reads them. Set on every boot, as /dev/null's.
mkdir -p "$LOGS_PATH/services"
chmod 640 "$LOGS_PATH/system"
chmod 750 "$LOGS_PATH/services" "$PIPELINES_PATH/instances"
