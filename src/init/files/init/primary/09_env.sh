# Publish the layout and the storage tier roots into /etc/layout, which /etc/bashrc sources.
#
# Boot exports the layout into its own shell, but a shell opened later builds its
# environment from /etc/bashrc alone — which is what `service start-all` hands to
# every service, and what a hand re-run of setup.sh gets.
#
# The file is boot's alone and rewritten whole, so its exports are always this boot's:
# a variable core stops exporting is gone after the next boot. It is only written
# when it differs, so an unchanged layout leaves no new version behind. Only boot's
# own shell has EIN_PATH_EXPORTS; a hand re-run of setup.sh leaves the file alone.
if [ -n "$EIN_PATH_EXPORTS" ]; then
  LAYOUT="$ETC_PATH/layout"
  # The shebang has it highlighted as bash, as /etc/bashrc is.
  LAYOUT_TEXT="#!bash
$EIN_PATH_EXPORTS"

  # The storage tier roots, for metrics-sampler's `df`.
  #
  # These are host paths that only boot.sh sees, and it uses them to mount rather than to
  # export — so a service shell asking where the disk tier lives has no other way to find out.
  # They are deployment facts rather than settings: nothing can change where the disk is
  # by writing to a file that lives on it, so they keep the EIN_ prefix and stay here.
  #
  # The CFG_ settings are published by `config publish`, in 10_config.sh.
  if [ -n "$EXTERNAL_FILE_ROOT_PATH" ]; then
    LAYOUT_TEXT="$LAYOUT_TEXT
export EIN_FILE_ROOT_PATH=\"$EXTERNAL_FILE_ROOT_PATH\""
  fi

  if [ -n "$EXTERNAL_VOLATILE_FILE_ROOT_PATH" ]; then
    LAYOUT_TEXT="$LAYOUT_TEXT
export EIN_VOLATILE_FILE_ROOT_PATH=\"$EXTERNAL_VOLATILE_FILE_ROOT_PATH\""
  fi

  if [ -n "$EXTERNAL_FILE_TMP_PATH" ]; then
    LAYOUT_TEXT="$LAYOUT_TEXT
export EIN_FILE_TMP_PATH=\"$EXTERNAL_FILE_TMP_PATH\""
  fi

  if [ ! -e "$LAYOUT" ] || [ "$(cat "$LAYOUT")" != "$LAYOUT_TEXT" ]; then
    echo "$LAYOUT_TEXT" > "$LAYOUT"
  fi

  # The line never changes, so adding it once is enough. 10_config.sh then moves the
  # configuration layers' source lines below it.
  LAYOUT_LINE="[ -r $LAYOUT ] && source $LAYOUT"
  grep -qF "$LAYOUT_LINE" /etc/bashrc || echo "$LAYOUT_LINE" >> /etc/bashrc
fi
