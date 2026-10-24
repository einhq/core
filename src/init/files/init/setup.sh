# Ensure init scripts are symlinked
for script in "$INIT_FILES_PATH/init/$INSTANCE_MODE"/[0-9][0-9]_*.sh; do
  [ -e "$script" ] || continue

  name=$(basename $script)

  [ -e "$INIT_PATH/$name" ] || ln -s "$script" "$INIT_PATH/$name"
done

# Run init scripts
for script in "$INIT_PATH"/[0-9][0-9]_*.sh; do
  [ -e "$script" ] || [ -L "$script" ] || continue

  # Remove dangling symlinks
  if [ -L "$script" ] && [ ! -e "$script" ]; then
    echo "Removing dangling symlink: $script"
    rm "$script"
    continue
  fi

  echo "> $script"
  "$script"
done
