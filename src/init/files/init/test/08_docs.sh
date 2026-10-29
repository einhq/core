# The guide — einhq.eu's documentation, as the image bundles it or a checkout of the site — mounted
# read-only at $DOCS_PATH/guide from the host directory boot was given, so it is the running
# version's. Without one the Docs page links to einhq.eu. The mount point must exist first.
# Guarded so a setup.sh re-run (no boot env, guide already mounted) stays idempotent.
mkdir -p "$DOCS_PATH"

if [ -n "$EXTERNAL_DOCS_PATH" ] && [ ! -e "$DOCS_PATH/guide/docs/SUMMARY.md" ]; then
  mkdir -p "$DOCS_PATH/guide"
  mount "$DOCS_PATH/guide" filesystem "filesPath=$EXTERNAL_DOCS_PATH,readonly"
fi
