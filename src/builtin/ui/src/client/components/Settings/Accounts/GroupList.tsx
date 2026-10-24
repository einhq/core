import { Box, Switch, Text, VisuallyHidden } from '@mantine/core';
import type { ReactNode } from 'react';
import type { GroupEntry, UserEntry } from '@ein/api';
import { displayName, membershipOf } from '../../../lib/accounts.ts';
import { countOf } from '../../../lib/count-of.ts';
import { matchesText } from '../../../lib/text-match.ts';
import { AccountFace } from './AccountAvatar.tsx';
import { GroupAvatar } from '../../Identity/GroupAvatar.tsx';
import { ListFrame, ListRow } from '../ListDetail.tsx';

type GroupListProps = {
  /** The groups to list, in display order. */
  groups: GroupEntry[];
  users: UserEntry[];
  /** The name of the group open beside the list. */
  selected?: string;
  onSelect: (groupname: string) => void;
  filter: string;
  onFilter: (next: string) => void;
  loading: boolean;
  /** Beside the filter: the button that makes a new entry. */
  action?: ReactNode;
  /** Beside the open entry: the rows scroll in their own box. */
  scrolls: boolean;
  showPersonal: boolean;
  /** Leaves the switch at the foot out when absent: when there is no personal group. */
  onShowPersonal?: (next: boolean) => void;
};

/** How many faces a row shows before it counts the rest. */
const FACES = 4;

/**
 * Who is in a group, at a row's right: the faces of its first members, linked or by primary
 * group, and how many more; `Everyone` for the group every account that signs in is in; nothing
 * for an empty group.
 */
function Members({ group, users }: { group: GroupEntry; users: UserEntry[] }) {
  if (group.role === 'everyone') return <Text size='xs' c='dimmed' style={{ flex: 'none' }}>Everyone</Text>;
  const members = users.filter((user) => {
    const membership = membershipOf(user, group);
    return membership === 'member' || membership === 'primary';
  });
  if (members.length === 0) return null;
  const rest = members.length - FACES;
  return (
    <>
      <Box className='mrx-face-pile' aria-hidden>
        {members.slice(0, FACES).map((user) => <AccountFace key={user.username} user={user} size={24} />)}
        {rest > 0 && <Text span size='xs' c='dimmed' className='mrx-face-pile-more'>+{rest}</Text>}
      </Box>
      <VisuallyHidden>{countOf(members.length, 'member', 'members')}</VisuallyHidden>
    </>
  );
}

/** The groups, narrowed by the filter, each opening its panel; the switch at the foot shows personal groups too. */
export function GroupList({ groups, users, selected, onSelect, filter, onFilter, loading, action, scrolls, showPersonal, onShowPersonal }: GroupListProps) {
  const shown = groups.filter((group) => matchesText([group.title, group.groupname, group.description], filter));
  return (
    <ListFrame
      what='groups'
      filter={filter}
      onFilter={onFilter}
      loading={loading}
      action={action}
      scrolls={scrolls}
      rows={shown.map((group) => (
        <ListRow
          key={group.groupname}
          selected={group.groupname === selected}
          onClick={() => onSelect(group.groupname)}
          avatar={<GroupAvatar role={group.role} size={36} />}
          title={displayName(group)}
          subtitle={group.groupname}
          aside={<Members group={group} users={users} />}
        />
      ))}
      footer={onShowPersonal && (
        <Switch
          size='sm'
          label='Show personal groups'
          checked={showPersonal}
          onChange={(event) => onShowPersonal(event.currentTarget.checked)}
        />
      )}
    />
  );
}
