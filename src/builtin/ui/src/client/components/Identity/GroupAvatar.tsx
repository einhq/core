import { Avatar } from '@mantine/core';
import { IconShieldLock, IconShieldUp, IconTerminal2, IconUserQuestion, IconUsers, IconUsersGroup } from '@tabler/icons-react';
import type { GroupRole } from '@ein/api';

const ROLE_ICONS: Record<GroupRole, typeof IconUsers> = {
  administrators: IconShieldLock,
  everyone: IconUsersGroup,
  ssh: IconTerminal2,
  sudo: IconShieldUp,
  guests: IconUserQuestion,
};

/** A group's picture: a round violet avatar with a built-in group's own icon, or the plain group icon. */
export function GroupAvatar({ role, size }: { role?: GroupRole; size: number }) {
  const Icon = role ? ROLE_ICONS[role] : IconUsers;
  return (
    <Avatar size={size} radius='xl' color='violet' variant='light' style={{ flex: 'none' }}>
      <Icon size={Math.round(size * 0.56)} />
    </Avatar>
  );
}
