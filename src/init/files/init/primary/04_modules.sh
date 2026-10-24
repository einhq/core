# Mount the modules the deployment provides at a temporary path
mknode -p -t directory "$DEV_MODULES_PATH"
mount "$DEV_MODULES_PATH" filesystem "filesPath=$EXTERNAL_DEV_MODULES_PATH,readonly"

# Link each module into $MOD_PATH
mkdir -p "$MOD_PATH"
for mod in $(ls "$DEV_MODULES_PATH"); do
  [ -e "$MOD_PATH/$mod" ] || ln -s "$DEV_MODULES_PATH/$mod" "$MOD_PATH/$mod"
done

# Set up in dependency order, not the alphabetical order `ls` gives.
mod setup --all || echo "module setup completed with failures; continuing boot"

echo "Module system initialized"
