import { Avatar, Button, Group, Stack, Text } from '@mantine/core';
import { IconFile, IconFolder, IconLockAccess } from '@tabler/icons-react';
import { useState } from 'react';
import type { ShareException, SharePreset } from '@ein/api';
import { thumbnailUrl } from '../../lib/derivatives.ts';
import { typeFromPath } from '../../lib/node-entry.ts';

/** How many are listed before "Show all". */
const FIRST = 5;

const REACH: Record<SharePreset, string> = {
  private: 'Private',
  shared: 'Shared differently',
  everyone: 'Open to visitors',
};

/** A picture's thumbnail, or the icon of what it is. */
function ExceptionThumb({ exception }: { exception: ShareException }) {
  const media = exception.type === 'file' && typeFromPath(exception.path) !== undefined;
  return (
    <Avatar size={36} radius='sm' src={media ? thumbnailUrl(exception.path, true) : undefined} alt='' style={{ flex: 'none' }}>
      {exception.type === 'file' ? <IconFile size={18} /> : <IconFolder size={18} />}
    </Avatar>
  );
}

type ExceptionsSectionProps = {
  exceptions: ShareException[];
  /** All of them the reader can see, of which `exceptions` is the first part. */
  count: number;
  /** What the node is called in a sentence: `album`. */
  noun: string;
  editable: boolean;
  /** Share these as the node is, and let its changes reach them again. */
  onFollow: (paths: string[]) => Promise<void>;
  /** The same for every one of them, those not in `exceptions` too. */
  onFollowAll: () => Promise<void>;
};

/**
 * What inside the node keeps its own sharing: the photos someone made private in a shared album.
 * The node's sharing, and its links, do not reach them until they are shared like it again.
 */
export function ExceptionsSection({ exceptions, count, noun, editable, onFollow, onFollowAll }: ExceptionsSectionProps) {
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const shown = all ? exceptions : exceptions.slice(0, FIRST);

  const follow = async (key: string, apply: () => Promise<void>) => {
    setBusy(key);
    try {
      await apply();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack gap='xs'>
      <Group gap='sm' wrap='nowrap'>
        <IconLockAccess size={18} style={{ flex: 'none' }} />
        <Text size='xs' c='dimmed' style={{ flex: 1 }}>
          {count === 1 ? 'This keeps' : 'These keep'} {count === 1 ? 'its' : 'their'} own sharing: changes to the {noun}'s sharing, and its link, do not reach{' '}
          {count === 1 ? 'it' : 'them'}.
        </Text>
        {editable && count > 1 && (
          <Button
            variant='subtle'
            size='compact-xs'
            loading={busy === '*'}
            disabled={busy !== null}
            onClick={() => follow('*', onFollowAll)}
            style={{ flex: 'none' }}
          >
            Share all like the {noun}
          </Button>
        )}
      </Group>

      <Stack gap={6}>
        {shown.map((exception) => (
          <Group key={exception.path} gap='sm' wrap='nowrap'>
            <ExceptionThumb exception={exception} />
            <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
              <Text size='sm' truncate>{exception.name}</Text>
              <Text size='xs' c='dimmed'>{REACH[exception.preset]}</Text>
            </Stack>
            {editable && (
              <Button
                variant='subtle'
                color='gray'
                size='compact-xs'
                loading={busy === exception.path}
                disabled={busy !== null}
                onClick={() => follow(exception.path, () => onFollow([exception.path]))}
                style={{ flex: 'none' }}
              >
                Share like the {noun}
              </Button>
            )}
          </Group>
        ))}
      </Stack>

      {!all && exceptions.length > FIRST && (
        <Button variant='subtle' size='compact-xs' onClick={() => setAll(true)} style={{ alignSelf: 'flex-start' }}>
          Show all {exceptions.length}
        </Button>
      )}
      {count > exceptions.length && (all || exceptions.length <= FIRST) && <Text size='xs' c='dimmed'>And {count - exceptions.length} more.</Text>}
    </Stack>
  );
}
