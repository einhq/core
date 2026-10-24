# $DOCS_PATH is a plain directory: the main guide is mounted read-only under
# $DOCS_PATH/guide, and modules link their own docs under $DOCS_PATH/modules/<name>
# (done by `mod setup`). A read-only mount can't host those child links, so
# $DOCS_PATH itself must stay a normal directory.
mkdir -p "$DOCS_PATH"
chown "$ADMIN_USERNAME:$USERS_GROUPNAME" "$DOCS_PATH"
chmod 775 "$DOCS_PATH"

mkdir -p "$DOCS_PATH/modules"
chown "$ADMIN_USERNAME:$USERS_GROUPNAME" "$DOCS_PATH/modules"
chmod 775 "$DOCS_PATH/modules"

# Mount the end-user guide from the source repo (docs/user), read-only so it
# tracks the running version. The mount point must exist first. Guarded so a
# setup.sh re-run (no boot env, guide already mounted) stays idempotent.
if [ -n "$EXTERNAL_DOCS_PATH" ] && [ ! -e "$DOCS_PATH/guide/index.md" ]; then
  mkdir -p "$DOCS_PATH/guide"
  mount "$DOCS_PATH/guide" filesystem "filesPath=$EXTERNAL_DOCS_PATH,readonly"
fi
