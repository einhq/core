mkdir -p "$HOMES_PATH"
mkdir -p "$USERS_PATH"
mkdir -p "$GROUPS_PATH"
mkdir -p "$SESSIONS_PATH"

group-exists "$ADMIN_GROUPNAME" || group-create "$ADMIN_GROUPNAME" --gid "$ADMIN_GID" --title "Administrators"
group-exists "$GUEST_GROUPNAME" || group-create "$GUEST_GROUPNAME" --gid "$GUEST_GID" --title "Guests"
group-exists "$USERS_GROUPNAME" || group-create "$USERS_GROUPNAME" --gid "$USERS_GID" --title "Users"
group-exists "$SSH_GROUPNAME" || group-create "$SSH_GROUPNAME" --title "SSH users" --description "May use ssh, scp and ssh-copy-id to reach other machines"
group-exists "$SUDO_GROUPNAME" || group-create "$SUDO_GROUPNAME" --title "Administrators on request" --description "May make a sign-in of theirs an administrator's by entering their password again"
user-exists "$ADMIN_USERNAME" || user-create "$ADMIN_USERNAME" --uid "$ADMIN_UID" --title "Administrator"
user-exists "$GUEST_USERNAME" || user-create "$GUEST_USERNAME" --uid "$GUEST_UID" --title "Guest"

group-is-member "$USERS_GROUPNAME" "$ADMIN_USERNAME" || group-add-member "$USERS_GROUPNAME" "$ADMIN_USERNAME" || true

# The primary sets a new instance's admin password once boot is through
# (src/init/admin-password.ts).
