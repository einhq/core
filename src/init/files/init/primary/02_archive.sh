# The archive: the parent of the content roots.
#
# Core's own root is the label tree, made here. The others are the modules':
# each declares its own in mod.json (`roots`) and `mod setup` creates it
# (04_modules.sh), so an instance without the archive module has no
# /archive/albums. A root that exists is left as it is, whoever owns it.
#
# Others — a share link, the guest — pass through and read nothing: what they
# see of the archive is what an access-list entry grants them. The roots made
# under it inherit that.
mkdir -p "$ARCHIVE_PATH"
chown "$ADMIN_USERNAME:$USERS_GROUPNAME" "$ARCHIVE_PATH"
chmod 771 "$ARCHIVE_PATH"

if [ ! -e "$TAGS_PATH" ]; then
  mkdir "$TAGS_PATH"
  chown "$ADMIN_USERNAME:$USERS_GROUPNAME" "$TAGS_PATH"
  chmod 771 "$TAGS_PATH"
fi
