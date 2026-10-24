# Mount the repo modules read-only and set up only those listed in TEST_MODULES
mknode -p -t directory "$DEV_MODULES_PATH"
mount "$DEV_MODULES_PATH" filesystem "filesPath=$EXTERNAL_DEV_MODULES_PATH,readonly"

mkdir -p "$MOD_PATH"
for mod in $TEST_MODULES; do
  [ -e "$MOD_PATH/$mod" ] || ln -s "$DEV_MODULES_PATH/$mod" "$MOD_PATH/$mod"
  mod setup "$mod" || echo "module '$mod' setup failed; continuing boot"
done
