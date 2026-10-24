/**
 * Startup script
 *
 * This module runs initialization commands when the server starts.
 */

import { join } from '@std/path';
import {
  ADMIN_GID,
  ADMIN_GROUPNAME,
  ADMIN_UID,
  ADMIN_USERNAME,
  GUEST_GID,
  GUEST_GROUPNAME,
  GUEST_UID,
  GUEST_USERNAME,
  SSH_GROUPNAME,
  SUDO_GROUPNAME,
  USERS_GID,
  USERS_GROUPNAME,
} from '../lib/access/mod.ts';
import { ETC_PATH, INIT_FILES_PATH, INIT_PATH, LIB_PATH, pathEnv, pathExports } from '../lib/paths.ts';
import { Shell } from '../managers/shell/shell.ts';
import { LIB_SOURCE_DIR } from '../modules/repo.ts';

type Instance = {
  mode: 'primary' | string;
  env?: Record<string, string>;
};

export async function boot(shell: Shell, instance: Instance): Promise<void> {
  const filesPath = join(import.meta.dirname!, 'files');

  const code = await shell.run(`
export INSTANCE_MODE=${instance.mode}
export ADMIN_USERNAME=${ADMIN_USERNAME}
export ADMIN_GROUPNAME=${ADMIN_GROUPNAME}
export ADMIN_UID=${ADMIN_UID}
export ADMIN_GID=${ADMIN_GID}
export GUEST_USERNAME=${GUEST_USERNAME}
export GUEST_GROUPNAME=${GUEST_GROUPNAME}
export GUEST_UID=${GUEST_UID}
export GUEST_GID=${GUEST_GID}
export USERS_GROUPNAME=${USERS_GROUPNAME}
export USERS_GID=${USERS_GID}
export SSH_GROUPNAME=${SSH_GROUPNAME}
export SUDO_GROUPNAME=${SUDO_GROUPNAME}
${Object.entries(pathEnv()).map(([key, value]) => `export ${key}="${value}"`).join('\n')}
export EIN_PATH_EXPORTS="${pathExports().replaceAll('"', '\\"')}"
${Object.entries(instance.env || {}).map(([key, value]) => `export ${key.toUpperCase()}="${value}"`).join('\n')}

echo "Mounting init files..."
mknode -p -t directory /_files
mount /_files filesystem "filesPath=${filesPath},readonly"

echo "Loading default environment..."
echo "> /_files/init/$INSTANCE_MODE/env.sh"
source /_files/init/$INSTANCE_MODE/env.sh

echo "Running boot script..."
echo "> /_files/init/$INSTANCE_MODE/boot.sh"
/_files/init/$INSTANCE_MODE/boot.sh

echo "Mounting core's files..."
mknode -p -t directory ${LIB_PATH}
mount ${LIB_PATH} filesystem "filesPath=${LIB_SOURCE_DIR},readonly"

echo "Setting up init files..."
mknode -p -t directory ${ETC_PATH}
mknode -p -t directory ${INIT_FILES_PATH}
mknode -p -t directory ${INIT_PATH}
mount ${INIT_FILES_PATH} filesystem "filesPath=${filesPath},readonly"

echo "Running setup..."
$INIT_FILES_PATH/init/setup.sh

# /_files exists only because the root is remounted onto PostgreSQL partway
# through this script: the init scripts have to be readable before the store
# they configure exists, so the bootstrap mount cannot live under /usr with the
# rest of the code. Nothing reads it after setup.sh returns — the symlinks in
# $INIT_PATH point at $INIT_FILES_PATH, which is a separate mount of the same
# host directory. Where the root was remounted, the mount point is covered by
# then, and unmount reaches it through the mount table.
echo "Unmounting bootstrap files..."
unmount /_files
# Where the root was not remounted, the mountpoint node that mknode created is
# still there and would show at the root as an empty directory.
[ -e /_files ] && rm -r /_files
true
`);

  if (code !== 0) {
    throw new Error(`Startup script failed with exit code ${code}`);
  }
}
