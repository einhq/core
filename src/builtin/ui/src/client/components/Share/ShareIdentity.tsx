import { Avatar, Center, Group, HoverCard, Loader, ScrollArea, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import type { GroupMember, GroupMemberPage, ShareGrant } from '@ein/api';
import { countOf } from '../../lib/count-of.ts';
import { shq } from '../../lib/shquote.ts';
import { execCommand } from '../../signals/shell-client.ts';
import { CoverAvatar } from '../Cover/CoverAvatar.tsx';
import { GroupAvatar } from '../Identity/GroupAvatar.tsx';

const AVATAR = 32;
const MEMBER_AVATAR = 28;

const initials = (name: string): string => name.slice(0, 2).toUpperCase();

/**
 * A person's picture: the cover photo of `path` — the person the account is, when it is one, or the
 * user node — or their initials.
 */
function PersonAvatar({ path, name, size = AVATAR }: { path?: string; name: string; size?: number }) {
  return path ? <CoverAvatar path={path} fallback={initials(name)} size={size} alt={name} /> : <Avatar size={size} radius='xl'>{initials(name)}</Avatar>;
}

/**
 * What a row calls a grantee, in words rather than account names: the group every signed-in person
 * is in is everyone with an account, a group says how many people it reaches.
 */
const grantLabel = (grant: Pick<ShareGrant, 'kind' | 'name' | 'title' | 'members' | 'role'>): { name: string; detail?: string } => {
  if (grant.kind === 'user') return { name: grant.title ?? grant.name, detail: grant.title ? grant.name : undefined };
  if (grant.role === 'everyone') return { name: 'Everyone with an account', detail: `The ${grant.title ?? grant.name} group` };
  return {
    name: grant.title ?? grant.name,
    detail: grant.members === undefined ? 'Group' : `Group · ${countOf(grant.members, 'person', 'people')}`,
  };
};

/** Avatar, name and what it is, side by side, taking the row's free width. */
function Identity({ avatar, name, detail }: { avatar: React.ReactNode; name: string; detail?: string }) {
  return (
    <Group gap='sm' wrap='nowrap' style={{ flex: 1, minWidth: 0 }}>
      {avatar}
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Text size='sm' truncate>{name}</Text>
        {detail && <Text size='xs' c='dimmed' truncate>{detail}</Text>}
      </Stack>
    </Group>
  );
}

/** The owner's row identity, marked when it is the reader; the row says Owner beside it. `path` is whose picture to show. */
export function OwnerIdentity({ name, username, path, you }: { name: string; username?: string; path?: string; you: boolean }) {
  return <Identity avatar={<PersonAvatar path={path} name={name} />} name={you ? `${name} (you)` : name} detail={username !== name ? username : undefined} />;
}

/** The members of a group, listed for an administrator who rests the pointer on its row. */
function GroupMembers({ grant }: { grant: ShareGrant }) {
  const [members, setMembers] = useState<GroupMemberPage | null | undefined>(undefined);

  const load = async () => {
    if (members !== undefined) return;
    try {
      const result = await execCommand<GroupMember[] | GroupMemberPage>(`group-members --limit=50 ${shq(grant.name)}`);
      setMembers(Array.isArray(result) ? { members: result.slice(0, 50), total: result.length } : result);
    } catch {
      setMembers(null);
    }
  };

  const label = grantLabel(grant);
  return (
    <HoverCard openDelay={250} closeDelay={150} position='top-start' withArrow shadow='md' width={280} onOpen={load}>
      <HoverCard.Target>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Identity avatar={<GroupAvatar role={grant.role} size={AVATAR} />} name={label.name} detail={label.detail} />
        </div>
      </HoverCard.Target>
      <HoverCard.Dropdown p='sm'>
        <Text size='sm' fw={500}>{grant.title ?? grant.name}</Text>
        {members === undefined && (
          <Center py='sm'>
            <Loader size='sm' />
          </Center>
        )}
        {members === null && <Text size='xs' c='dimmed' mt='xs'>The members could not be read.</Text>}
        {members && (
          <>
            <ScrollArea.Autosize mah={320} type='auto' offsetScrollbars scrollbarSize={6} mt='xs'>
              <Stack gap='xs'>
                {members.members.map((member) => (
                  <Group key={member.uid ?? member.username} gap='xs' wrap='nowrap'>
                    <PersonAvatar path={member.personPath} name={member.title ?? member.username} size={MEMBER_AVATAR} />
                    <Text size='sm' truncate>{member.title ?? member.username}</Text>
                  </Group>
                ))}
              </Stack>
            </ScrollArea.Autosize>
            {members.total > members.members.length && <Text size='xs' c='dimmed' mt='xs'>The first 50 of {members.total} members.</Text>}
          </>
        )}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/**
 * A grant's row identity. A group lists its members when the pointer rests on it, for an
 * administrator: whom it reaches is group membership, which only they may read.
 */
export function GrantIdentity({ grant, showMembers }: { grant: ShareGrant; showMembers: boolean }) {
  if (grant.kind === 'group' && showMembers && grant.role !== 'everyone') return <GroupMembers grant={grant} />;
  const label = grantLabel(grant);
  const avatar = grant.kind === 'group' ? <GroupAvatar role={grant.role} size={AVATAR} /> : <PersonAvatar path={grant.personPath ?? grant.path} name={label.name} />;
  return <Identity avatar={avatar} name={label.name} detail={label.detail} />;
}
