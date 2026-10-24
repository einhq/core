# Mirrors ../primary/02_archive.sh; the modules' roots are created by `mod setup` of the
# modules the test names (04_modules.sh), as in production.
mkdir -p "$ARCHIVE_PATH"
chown "$ADMIN_USERNAME:$USERS_GROUPNAME" "$ARCHIVE_PATH"
chmod 775 "$ARCHIVE_PATH"

if [ ! -e "$TAGS_PATH" ]; then
  mkdir "$TAGS_PATH"
  chown "$ADMIN_USERNAME:$USERS_GROUPNAME" "$TAGS_PATH"
  chmod 775 "$TAGS_PATH"
fi
