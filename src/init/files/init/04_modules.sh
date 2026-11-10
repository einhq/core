# The modules the deployment provides, mounted read-only at a temporary path
mknode -p -t directory "$DEV_MODULES_PATH"
mount "$DEV_MODULES_PATH" filesystem "filesPath=$EXTERNAL_DEV_MODULES_PATH,readonly"

# The deployment's folder for the modules `mod install` installs, read-write. Without one,
# `mod install` writes into the instance's store. No queue is bound to a module's files, and an
# install writes thousands of them, so their events stay in-process (ein/core#923).
if [ -n "$EXTERNAL_MODULE_INSTALL_PATH" ]; then
  mknode -p -t directory "$MOD_INSTALL_PATH"
  mount "$MOD_INSTALL_PATH" filesystem "filesPath=$EXTERNAL_MODULE_INSTALL_PATH,nopublish"
fi

# A softlink at $2 to $1, replaced when it points anywhere else.
link() {
  [ "$(JSON_OUTPUT=1 props -L "$2" 2>/dev/null | jq -r '.softlink // empty')" = "$1" ] || ln -sf "$1" "$2"
}

# Link each module — a directory with a mod.json — into $MOD_PATH: those DEV_MODULES names, when it
# is set (the test harness's, the modules a test loads), or every one provided. A name the
# deployment provides is the deployment's, whatever is installed under it.
mkdir -p "$MOD_PATH"
if [ -n "${DEV_MODULES+set}" ]; then
  provided="$DEV_MODULES"
else
  provided=$(ls "$DEV_MODULES_PATH")
fi
for mod in $provided; do
  [ -e "$DEV_MODULES_PATH/$mod/mod.json" ] || continue
  link "$DEV_MODULES_PATH/$mod" "$MOD_PATH/$mod"
done
mkdir -p "$MOD_INSTALL_PATH"
for mod in $(ls "$MOD_INSTALL_PATH"); do
  [ -e "$MOD_INSTALL_PATH/$mod/mod.json" ] || continue
  if [ -e "$DEV_MODULES_PATH/$mod/mod.json" ]; then
    echo "module '$mod' is installed and among the deployment's modules: the deployment's runs"
    continue
  fi
  link "$MOD_INSTALL_PATH/$mod" "$MOD_PATH/$mod"
done

# The modules the deployment asks for and lacks, fetched into $MOD_INSTALL_PATH, and each installed
# one this core cannot run, as after an update of core that changed the module API, replaced from
# its repository by the newest release this core runs; any other installed one is left as it is,
# without asking a forge. The installed ones go first, so a name in INSTALL_MODULES finds its
# module whole. Setting them up is the next line's, and starting their services the last boot
# script's, once this boot's settings are written.
installed=
for mod in $(ls "$MOD_INSTALL_PATH"); do
  [ -e "$MOD_INSTALL_PATH/$mod/.install.json" ] || continue
  [ ! -e "$DEV_MODULES_PATH/$mod/mod.json" ] || continue
  installed="$installed $(jq -r .repository "$MOD_INSTALL_PATH/$mod/.install.json")"
done
if [ -n "$installed$INSTALL_MODULES" ]; then
  mod install --missing --no-setup $installed $INSTALL_MODULES || echo "some modules could not be installed or replaced; continuing boot"
fi

# Set up in dependency order, not the alphabetical order `ls` gives.
mod setup --all || echo "module setup completed with failures; continuing boot"

echo "Module system initialized"
