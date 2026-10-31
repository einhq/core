# Mirrors ../primary/03_core.sh, without the browser shell: a test instance serves no pages of its
# own, so `mod setup` builds no module pages for it either.

CORE_FILES="$LIB_PATH/core"

link() {
  [ "$(JSON_OUTPUT=1 props -L "$2" 2>/dev/null | jq -r '.softlink // empty')" = "$1" ] || ln -sf "$1" "$2"
}

[ -e "$ETC_PATH/bashrc" ] || cp "$CORE_FILES/etc/bashrc" "$ETC_PATH/bashrc"

# The seed /etc/frozen-uploads: the types of upload that are frozen as they arrive. Copied once,
# like /etc/bashrc.
[ -e "$ETC_PATH/frozen-uploads" ] || cp "$CORE_FILES/etc/frozen-uploads" "$ETC_PATH/frozen-uploads"

for service in $(ls "$CORE_FILES/services"); do
  service add "$service" "$CORE_FILES/services/$service" > /dev/null && service enable "$service" > /dev/null
done

link "$CORE_FILES/ui" "$WWW_PATH/core"
