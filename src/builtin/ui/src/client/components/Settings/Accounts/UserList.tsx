import { Badge, Switch, VisuallyHidden } from '@mantine/core';
import type { ReactNode } from 'react';
import type { SessionEntry, UserEntry } from '@ein/api';
import { accountStatus, displayName, signedIn } from '../../../lib/accounts.ts';
import { matchesText } from '../../../lib/text-match.ts';
import { AccountAvatar } from './AccountAvatar.tsx';
import { ListFrame, ListRow } from '../ListDetail.tsx';

type UserListProps = {
  /** In display order. */
  users: UserEntry[];
  sessions: SessionEntry[];
  /** The username of the account open beside the list. */
  selected?: string;
  onSelect: (username: string) => void;
  filter: string;
  onFilter: (next: string) => void;
  loading: boolean;
  /** Beside the filter: the button that makes a new entry. */
  action?: ReactNode;
  /** Beside the open entry: the rows scroll in their own box. */
  scrolls: boolean;
  showDisabled: boolean;
  /** Leaves the switch at the foot out when absent: when no account is disabled. */
  onShowDisabled?: (next: boolean) => void;
};

/** A badge for an account that cannot sign in; none for one that can. */
function StatusBadge({ user }: { user: UserEntry }) {
  const status = accountStatus(user);
  if (status === 'active') return null;
  return (
    <Badge size='sm' variant='dot' color={status === 'disabled' ? 'gray' : 'yellow'} tt='none' style={{ flex: 'none' }}>
      {status === 'disabled' ? 'Disabled' : 'No password'}
    </Badge>
  );
}

/**
 * The accounts, narrowed by the filter, each opening its panel: its name under its title, a teal
 * dot on the picture while it is signed in, and a badge when it cannot sign in. The switch at the
 * foot shows disabled accounts too.
 */
export function UserList({ users, sessions, selected, onSelect, filter, onFilter, loading, action, scrolls, showDisabled, onShowDisabled }: UserListProps) {
  const shown = users.filter((user) => matchesText([user.title, user.username, user.description], filter));
  return (
    <ListFrame
      what='users'
      filter={filter}
      onFilter={onFilter}
      loading={loading}
      action={action}
      scrolls={scrolls}
      rows={shown.map((user) => {
        const present = signedIn(user, sessions).length > 0;
        return (
          <ListRow
            key={user.username}
            selected={user.username === selected}
            onClick={() => onSelect(user.username)}
            avatar={
              <>
                <AccountAvatar user={user} size={36} />
                {present && <span className='mrx-presence-dot' title='Signed in now' />}
              </>
            }
            title={displayName(user)}
            subtitle={user.username}
            aside={
              <>
                {present && <VisuallyHidden>Signed in now</VisuallyHidden>}
                <StatusBadge user={user} />
              </>
            }
          />
        );
      })}
      footer={onShowDisabled && (
        <Switch
          size='sm'
          label='Show disabled users'
          checked={showDisabled}
          onChange={(event) => onShowDisabled(event.currentTarget.checked)}
        />
      )}
    />
  );
}
