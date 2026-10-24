# Publish the layout into /etc/layout — see the note in ../primary/09_env.sh.
# Test mode has no storage tier roots, so this is the layout half only.
if [ -n "$EIN_PATH_EXPORTS" ]; then
  LAYOUT="$ETC_PATH/layout"
  LAYOUT_TEXT="#!bash
$EIN_PATH_EXPORTS"

  if [ ! -e "$LAYOUT" ] || [ "$(cat "$LAYOUT")" != "$LAYOUT_TEXT" ]; then
    echo "$LAYOUT_TEXT" > "$LAYOUT"
  fi

  LAYOUT_LINE="[ -r $LAYOUT ] && source $LAYOUT"
  grep -qF "$LAYOUT_LINE" /etc/bashrc || echo "$LAYOUT_LINE" >> /etc/bashrc
fi
