# The modules the deployment provides, mounted read-only at a temporary path
mknode -p -t directory "$DEV_MODULES_PATH"
mount "$DEV_MODULES_PATH" filesystem "filesPath=$EXTERNAL_DEV_MODULES_PATH,readonly"

# The deployment's folder for the modules `mod install` installs, read-write
mknode -p -t directory "$MOD_INSTALL_PATH"
mount "$MOD_INSTALL_PATH" filesystem "filesPath=$EXTERNAL_MODULE_INSTALL_PATH"

# A softlink at $2 to $1, replaced when it points anywhere else.
link() {
  [ "$(JSON_OUTPUT=1 props -L "$2" 2>/dev/null | jq -r '.softlink // empty')" = "$1" ] || ln -sf "$1" "$2"
}

# Link each module — a directory with a mod.json — into $MOD_PATH. A name the deployment provides
# is the deployment's, whatever is installed under it.
mkdir -p "$MOD_PATH"
for mod in $(ls "$DEV_MODULES_PATH"); do
  [ -e "$DEV_MODULES_PATH/$mod/mod.json" ] || continue
  link "$DEV_MODULES_PATH/$mod" "$MOD_PATH/$mod"
done
for mod in $(ls "$MOD_INSTALL_PATH"); do
  [ -e "$MOD_INSTALL_PATH/$mod/mod.json" ] || continue
  if [ -e "$DEV_MODULES_PATH/$mod/mod.json" ]; then
    echo "module '$mod' is installed and among the deployment's modules: the deployment's runs"
    continue
  fi
  link "$MOD_INSTALL_PATH/$mod" "$MOD_PATH/$mod"
done

# The modules the deployment asks for and lacks, fetched into $MOD_INSTALL_PATH; one installed
# already is left as it is. Setting them up is the next line's, and starting their services the
# last boot script's, once this boot's settings are written.
if [ -n "$INSTALL_MODULES" ]; then
  mod install --missing --no-setup $INSTALL_MODULES || echo "some of INSTALL_MODULES could not be installed; continuing boot"
fi

# Set up in dependency order, not the alphabetical order `ls` gives.
mod setup --all || echo "module setup completed with failures; continuing boot"

echo "Module system initialized"
