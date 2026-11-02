# Core's own setup, from the files boot mounts at $LIB_PATH, before any module is set up.

CORE_FILES="$LIB_PATH/core"
SHELL_FILES="$LIB_PATH/ui/ui"

# A softlink at $2 to $1, replaced when it points anywhere else.
link() {
  [ "$(JSON_OUTPUT=1 props -L "$2" 2>/dev/null | jq -r '.softlink // empty')" = "$1" ] || ln -sf "$1" "$2"
}

# The seed /etc/bashrc: the aliases, the history size and the lines that source the settings.
# Copied once; from then on the file is the administrator's.
[ -e "$ETC_PATH/bashrc" ] || cp "$CORE_FILES/etc/bashrc" "$ETC_PATH/bashrc"

# The seed /etc/frozen-uploads: the types of upload that are frozen as they arrive. Copied once,
# like /etc/bashrc.
[ -e "$ETC_PATH/frozen-uploads" ] || cp "$CORE_FILES/etc/frozen-uploads" "$ETC_PATH/frozen-uploads"

# Core's services, registered and enabled at every boot; one core no longer ships is retired. A
# headless instance (HEADLESS, the test harness's, which serves HTTP itself) listens on no port of
# its own, so it leaves the HTTP and SSH servers disabled.
for service in $(ls "$CORE_FILES/services"); do
  service add "$service" "$CORE_FILES/services/$service" > /dev/null || continue
  case "$HEADLESS:$service" in
    1:http-server | 1:ssh-server) service disable "$service" > /dev/null || true ;;
    *) service enable "$service" > /dev/null ;;
  esac
done
for service in $(ls "$SERVICES_PATH/available"); do
  target=$(JSON_OUTPUT=1 props -L "$SERVICES_PATH/available/$service" | jq -r '.softlink // empty')
  case "$target" in
    "$CORE_FILES/services/"*)
      if [ ! -e "$target" ]; then
        service disable "$service" > /dev/null
        service remove "$service" > /dev/null && echo "Retired service '$service'"
      fi
      ;;
  esac
done

# The sites: the browser shell with its navigation entries, when it is built and the instance is
# not headless, which `www reset` makes the default, and the terminal page, which `www set core`
# makes it instead. Without the shell, `mod setup` builds no module pages either.
link "$CORE_FILES/ui" "$WWW_PATH/core"
if [ "$HEADLESS" != 1 ] && [ -e "$SHELL_FILES/index.html" ]; then
  link "$SHELL_FILES" "$WWW_PATH/ui"
  mkdir -p "$ETC_PATH/ui/nav.d"
  link "$SHELL_FILES/nav.json" "$ETC_PATH/ui/nav.d/ui.json"
fi
