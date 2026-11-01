import { ActionIcon, Group, Menu, SegmentedControl, Tooltip } from '@mantine/core';
import { IconArrowsSort, IconCheck, IconEye, IconEyeOff, IconLayoutGrid, IconLayoutList, IconListDetails } from '@tabler/icons-react';
import { useSignals } from '@preact/signals-react/runtime';
import { type NodeSort, SORT_KEYS, type ViewMode } from '../../lib/nodes-workspace.ts';
import { invalidateListing } from '../../signals/nodes.ts';
import { currentUser } from '../../signals/user.ts';
import { homePath } from '@ein/paths';
import { NodeAddressBar } from './NodeAddressBar.tsx';

type NodePaneBarProps = {
  path: string;
  onNavigate: (path: string) => void;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  showHidden: boolean;
  onShowHidden: (showHidden: boolean) => void;
  sort: NodeSort;
  onSort: (sort: NodeSort) => void;
};

const VIEWS: { value: ViewMode; label: string; icon: React.ReactNode }[] = [
  { value: 'details', label: 'Details', icon: <IconListDetails size={14} /> },
  { value: 'list', label: 'List', icon: <IconLayoutList size={14} /> },
  { value: 'icons', label: 'Icons', icon: <IconLayoutGrid size={14} /> },
];

const SORT_LABELS: Record<NodeSort['key'], string> = { name: 'Name', type: 'Type', size: 'Size', modified: 'Modified' };

/**
 * The bar over a listing: the address with its way home and its reload, the
 * view, whether dot names show, and — in the views without column names to
 * click — the sort.
 */
export function NodePaneBar({ path, onNavigate, view, onView, showHidden, onShowHidden, sort, onSort }: NodePaneBarProps) {
  useSignals();
  const user = currentUser.value;

  return (
    <Group gap={4} wrap='nowrap' p={4} style={{ background: 'var(--mrx-surface-raised)', borderBottom: '1px solid var(--mrx-hairline)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <NodeAddressBar
          path={path}
          home={user ? homePath(user.username) : undefined}
          onNavigate={onNavigate}
          onRefresh={() => invalidateListing(path)}
        />
      </div>
      <SegmentedControl
        size='xs'
        value={view}
        onChange={(value) => onView(value as ViewMode)}
        data={VIEWS.map((view) => ({
          value: view.value,
          label: (
            <Tooltip label={view.label} withArrow>
              <span style={{ display: 'flex' }}>{view.icon}</span>
            </Tooltip>
          ),
        }))}
      />
      <Tooltip label={showHidden ? 'Hide names starting with a dot (Ctrl+H)' : 'Show names starting with a dot (Ctrl+H)'} withArrow>
        <ActionIcon
          variant={showHidden ? 'light' : 'subtle'}
          color='gray'
          onClick={() => onShowHidden(!showHidden)}
          aria-label='Show hidden'
          aria-pressed={showHidden}
        >
          {showHidden ? <IconEye size={16} /> : <IconEyeOff size={16} />}
        </ActionIcon>
      </Tooltip>
      {
        /* The details view sorts on its column names; the others have none. */
      }
      {view !== 'details' && (
        <Menu shadow='md' withinPortal position='bottom-end'>
          <Menu.Target>
            <Tooltip label={`Sorted by ${SORT_LABELS[sort.key].toLowerCase()}, ${sort.dir === 'asc' ? 'ascending' : 'descending'}`} withArrow>
              <ActionIcon variant='subtle' color='gray' aria-label='Sort'>
                <IconArrowsSort size={16} />
              </ActionIcon>
            </Tooltip>
          </Menu.Target>
          <Menu.Dropdown>
            {SORT_KEYS.map((key) => (
              <Menu.Item
                key={key}
                rightSection={sort.key === key ? <IconCheck size={14} /> : undefined}
                onClick={() => onSort({ key, dir: sort.key === key ? (sort.dir === 'asc' ? 'desc' : 'asc') : 'asc' })}
              >
                {SORT_LABELS[key]}
                {sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );
}
