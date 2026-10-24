import { Avatar, Box } from '@mantine/core';
import type { UserEntry } from '@ein/api';
import { displayName } from '../../../lib/accounts.ts';
import { hashString } from '../../../lib/hash-string.ts';
import { CoverAvatar } from '../../Cover/CoverAvatar.tsx';
import { HatIdenticon } from '../../Identity/HatIdenticon.tsx';

/** A hue of the username's own, at one lightness and strength, so that no account outshines another. */
const accountColor = (username: string): string => `oklch(78% 0.12 ${hashString(username) % 360})`;

/**
 * An account's picture: its person's cover when the account is linked to one, else a hat identicon
 * of its username in the username's hue. A disabled account's is faded to gray.
 */
export function AccountAvatar({ user, size }: { user: UserEntry; size: number }) {
  const name = displayName(user);
  const color = accountColor(user.username);
  const identicon = (
    <Box
      w={size}
      h={size}
      style={{ borderRadius: 'var(--mantine-radius-md)', background: `color-mix(in srgb, ${color} 14%, var(--mrx-surface-raised))` }}
    >
      <HatIdenticon seed={`user:${user.username}`} label={name} color={color} />
    </Box>
  );

  return (
    <Box w={size} h={size} style={{ flex: 'none', ...(user.inactive ? { opacity: 0.5, filter: 'grayscale(1)' } : {}) }}>
      {user.personPath ? <CoverAvatar path={user.personPath} fallback={identicon} size={size} radius='md' alt={name} /> : identicon}
    </Box>
  );
}

/**
 * An account as a small round face, for a pile of them: its person's cover, or its initials in its
 * hue. Too small for the hat pattern to read, so the initials stand alone.
 */
export function AccountFace({ user, size }: { user: UserEntry; size: number }) {
  const name = displayName(user);
  const color = accountColor(user.username);
  const initials = (
    <Avatar
      size={size}
      radius='xl'
      name={name}
      alt={name}
      styles={{
        root: { flex: 'none', ...(user.inactive ? { opacity: 0.5, filter: 'grayscale(1)' } : {}) },
        placeholder: { background: `color-mix(in srgb, ${color} 26%, var(--mrx-surface-raised))`, color, fontSize: Math.round(size * 0.4), fontWeight: 700 },
      }}
    />
  );
  return user.personPath ? <CoverAvatar path={user.personPath} fallback={initials} size={size} radius='xl' alt={name} /> : initials;
}
