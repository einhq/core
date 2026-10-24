import { Badge, Tooltip } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { IconLock, IconLockAccess, IconWorld } from '@tabler/icons-react';
import type { NodeOwnership } from '@ein/api';
import { ownershipVisibility, type Visibility } from '../../lib/share.ts';
import { openShareModal } from '../../signals/share.ts';
import { guestBrowsing } from '../../signals/user.ts';

/** Each visibility's word, colour, icon, and what it means. */
export const VISIBILITY = {
  public: { label: 'Public', color: 'green', Icon: IconWorld, explain: 'Anyone with its link, or any visitor, can see it without signing in' },
  restricted: { label: 'Restricted', color: 'orange', Icon: IconLockAccess, explain: 'Only some of the people with an account can see it' },
  private: { label: 'Private', color: 'red', Icon: IconLock, explain: 'Only its owner can see it' },
} as const;

/** A visibility as a badge; nothing for the default, where every account sees it. */
export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  if (!visibility) return null;
  const { label, color, Icon } = VISIBILITY[visibility];
  return (
    <Badge variant='light' color={color} leftSection={<Icon size={12} />} style={{ textTransform: 'none' }}>
      {label}
    </Badge>
  );
}

/**
 * How visible a node is, in a word under its title — public, restricted, or private — and nothing
 * when every account sees it, as most things are. Opens the sharing dialog, which says who exactly.
 */
export function SharingChip({ path, ownership }: { path: string; ownership: NodeOwnership }) {
  useSignals();
  const visibility = ownershipVisibility(ownership, guestBrowsing.value);
  if (!visibility) return null;
  const { label, color, Icon, explain } = VISIBILITY[visibility];

  return (
    <Tooltip label={explain} withArrow>
      <Badge
        component='button'
        type='button'
        variant='light'
        color={color}
        leftSection={<Icon size={12} />}
        onClick={() => openShareModal(path)}
        style={{ cursor: 'pointer', textTransform: 'none' }}
      >
        {label}
      </Badge>
    </Tooltip>
  );
}
