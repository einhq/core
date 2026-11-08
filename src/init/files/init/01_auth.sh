mkdir -p "$HOMES_PATH"
mkdir -p "$GROUP_HOMES_PATH"
mkdir -p "$USERS_PATH"
mkdir -p "$GROUPS_PATH"
mkdir -p "$SESSIONS_PATH"

group-exists "$ADMIN_GROUPNAME" || group-create "$ADMIN_GROUPNAME" --gid "$ADMIN_GID" --title "Administrators"
group-exists "$GUEST_GROUPNAME" || group-create "$GUEST_GROUPNAME" --gid "$GUEST_GID" --title "Guests"
group-exists "$USERS_GROUPNAME" || group-create "$USERS_GROUPNAME" --gid "$USERS_GID" --title "Users"
group-exists "$SSH_GROUPNAME" || group-create "$SSH_GROUPNAME" --title "SSH users" --description "May use ssh, scp and ssh-copy-id to reach other machines"
group-exists "$SUDO_GROUPNAME" || group-create "$SUDO_GROUPNAME" --title "Administrators on request" --description "May make a sign-in of theirs an administrator's by entering their password again"
group-exists "$DEVICES_GROUPNAME" || group-create "$DEVICES_GROUPNAME" --title "Devices" --description "May make, name and forget the devices under /dev"
user-exists "$ADMIN_USERNAME" || user-create "$ADMIN_USERNAME" --uid "$ADMIN_UID" --title "Administrator"
user-exists "$GUEST_USERNAME" || user-create "$GUEST_USERNAME" --uid "$GUEST_UID" --title "Guest"

group-is-member "$USERS_GROUPNAME" "$ADMIN_USERNAME" || group-add-member "$USERS_GROUPNAME" "$ADMIN_USERNAME" || true

# /dev is the administrator's, so nothing of core's there (null, the event routers) nor another's
# device is removed by anyone else: the devices group's members make and forget devices through
# device-create and device-forget, which act for them. Set on every boot, whatever /dev has.
chown "$ADMIN_USERNAME:$ADMIN_GROUPNAME" /dev
chmod 755 /dev

# Everyone signed in shares the home of `users`, the household's. Made once, as the attr on the
# homes' directory records: an administrator who takes it away (group-home --off) does not get it
# back at the next boot.
if [ -z "$(JSON_OUTPUT=1 attrs "$GROUP_HOMES_PATH" | jq -r '.usersHomeMade // empty')" ]; then
  [ -e "$GROUP_HOMES_PATH/$USERS_GROUPNAME" ] || group-home "$USERS_GROUPNAME"
  attrs -s usersHomeMade=true "$GROUP_HOMES_PATH" >/dev/null
fi

# A new instance's admin password is set once boot is through
# (src/init/admin-password.ts).
