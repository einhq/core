# Mount the repo modules read-only and set up only those listed in TEST_MODULES
mknode -p -t directory "$DEV_MODULES_PATH"
mount "$DEV_MODULES_PATH" filesystem "filesPath=$EXTERNAL_DEV_MODULES_PATH,readonly"

mkdir -p "$MOD_PATH"
for mod in $TEST_MODULES; do
  [ -e "$MOD_PATH/$mod" ] || ln -s "$DEV_MODULES_PATH/$mod" "$MOD_PATH/$mod"
  mod setup "$mod" || echo "module '$mod' setup failed; continuing boot"
done

# A test that installs modules names a folder for them, mounted, linked and set up as the primary
# instance does; without one, `mod install` writes into the instance's store.
if [ -n "$EXTERNAL_MODULE_INSTALL_PATH" ]; then
  mount "$MOD_INSTALL_PATH" filesystem "filesPath=$EXTERNAL_MODULE_INSTALL_PATH"
  if [ -n "$INSTALL_MODULES" ]; then
    mod install --missing --no-setup $INSTALL_MODULES || echo "some of INSTALL_MODULES could not be installed; continuing boot"
  fi
  for mod in $(ls "$MOD_INSTALL_PATH"); do
    [ -e "$MOD_INSTALL_PATH/$mod/mod.json" ] || continue
    [ -e "$MOD_PATH/$mod" ] || ln -s "$MOD_INSTALL_PATH/$mod" "$MOD_PATH/$mod"
    mod setup "$mod" || echo "module '$mod' setup failed; continuing boot"
  done
fi
