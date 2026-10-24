import { ActionIcon, Anchor, Box, Group, Text, TextInput, Tooltip } from '@mantine/core';
import { IconArrowUp, IconHome, IconRefresh } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { normalizePath, parentPath, pathCrumbs } from '../../lib/node-path.ts';

type NodeAddressBarProps = {
  path: string;
  /** The reader's home directory, for the Home button; absent until the user is known. */
  home?: string;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
};

/**
 * Where the tab is, as clickable segments — or as text, once clicked.
 *
 * The segments are the common case: going up two levels is two clicks away
 * and nothing has to be typed. The text field is for the path that is not on
 * screen, and it is the same box so the eye does not have to move.
 */
export function NodeAddressBar({ path, home, onNavigate, onRefresh }: NodeAddressBarProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(path);
  }, [path, editing]);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = normalizePath(draft);
    if (next !== path) onNavigate(next);
  };

  const crumbs = pathCrumbs(path);

  return (
    <Group gap={4} wrap='nowrap'>
      <Tooltip label='Up' withArrow>
        <ActionIcon variant='subtle' color='gray' onClick={() => onNavigate(parentPath(path))} disabled={path === '/'} aria-label='Up'>
          <IconArrowUp size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label='Home' withArrow>
        <ActionIcon variant='subtle' color='gray' onClick={() => home && onNavigate(home)} disabled={!home || path === home} aria-label='Home'>
          <IconHome size={16} />
        </ActionIcon>
      </Tooltip>
      {editing
        ? (
          <TextInput
            ref={input}
            size='xs'
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') {
                setDraft(path);
                setEditing(false);
              }
            }}
            style={{ flex: 1 }}
            ff='monospace'
            spellCheck={false}
          />
        )
        : (
          <Box
            onClick={() => setEditing(true)}
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              height: 30,
              padding: '0 8px',
              border: '1px solid var(--mrx-hairline)',
              borderRadius: 'var(--mantine-radius-sm)',
              background: 'var(--mrx-surface-base)',
              cursor: 'text',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
            }}
            title='Click to edit the path'
          >
            <Anchor
              size='sm'
              c='dimmed'
              ff='monospace'
              onClick={(event) => {
                event.stopPropagation();
                onNavigate('/');
              }}
            >
              /
            </Anchor>
            {crumbs.map((crumb, index) => (
              <Group key={crumb.path} gap={2} wrap='nowrap' style={{ minWidth: 0, flexShrink: index === crumbs.length - 1 ? 1 : 0 }}>
                {index > 0 && <Text size='sm' c='dimmed' ff='monospace'>/</Text>}
                <Anchor
                  size='sm'
                  ff='monospace'
                  c={index === crumbs.length - 1 ? undefined : 'dimmed'}
                  truncate
                  onClick={(event) => {
                    event.stopPropagation();
                    onNavigate(crumb.path);
                  }}
                >
                  {crumb.name}
                </Anchor>
              </Group>
            ))}
          </Box>
        )}
      <Tooltip label='Refresh' withArrow>
        <ActionIcon variant='subtle' color='gray' onClick={onRefresh} aria-label='Refresh'>
          <IconRefresh size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
