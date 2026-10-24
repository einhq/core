# The machine's floor: the mounts, the event endpoints, and the /var skeleton.
#
# Every /var directory is created here rather than by whatever writes to it
# first, so `ls /` and `ls /var` read the same on a fresh instance as on one
# that has done some work.
mkdir -p "$BIN_PATH"
mount "$BIN_PATH" command

mkdir -p "$TEMP_PATH"
mount "$TEMP_PATH" memory "filesPath=$EXTERNAL_FILE_TMP_PATH,mode=777"

mkdir -p $VAR_DIRS

mkdir -p /dev
# Reads of /dev/null end at once and writes to it are discarded, as on Linux. Anything else
# found at the path is replaced; the mode is set on every boot, whatever an existing one has.
[ -c /dev/null ] || { rm -f /dev/null; mknode -t null /dev/null; }
chmod 666 /dev/null
[ -e /dev/events ] || mknode -t router --as routingKey=system.events /dev/events
[ -e /dev/pipeline-events ] || mknode -t router --as routingKey=system.pipeline /dev/pipeline-events

[ -e "$LOGS_PATH/system" ] || mknode -t log --al routingKeys=system.logs "$LOGS_PATH/system"
truncate "$LOGS_PATH/system"
