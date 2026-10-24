import { ActionIcon, Group, Menu, SegmentedControl, Tooltip } from '@mantine/core';
import { IconArrowsSort, IconCheck, IconEye, IconEyeOff, IconLayoutGrid, IconLayoutList, IconListDetails } from '@tabler/icons-react';
import { useSignals } from '@preact/signals-react/runtime';
import type { Identities } from '../../hooks/useIdentities.ts';
import { activeTabOf, type NodeSort, type PaneIndex, type PaneState, SORT_KEYS, type ViewMode } from '../../lib/nodes-workspace.ts';
import { focusNodesPane, invalidateListing, nodesWorkspace, setNodesShowHidden, setNodesTabPath, setNodesTabSort, setNodesTabView } from '../../signals/nodes.ts';
import { currentUser } from '../../signals/user.ts';
import { homePath } from '@ein/paths';
import { NodeAddressBar } from './NodeAddressBar.tsx';
import { NodeTabView } from './NodeTabView.tsx';

type NodePaneProps = {
  index: PaneIndex;
  pane: PaneState;
  /** The pane with the keyboard; with one pane, always that one. */
  focused: boolean;
  names: Identities;
};

const VIEWS: { value: ViewMode; label: string; icon: React.ReactNode }[] = [
  { value: 'details', label: 'Details', icon: <IconListDetails size={14} /> },
  { value: 'list', label: 'List', icon: <IconLayoutList size={14} /> },
  { value: 'icons', label: 'Icons', icon: <IconLayoutGrid size={14} /> },
];

const SORT_LABELS: Record<NodeSort['key'], string> = { name: 'Name', type: 'Type', size: 'Size', modified: 'Modified' };

/**
 * One pane of the explorer: the active tab's address and view controls, and
 * every tab's tree with only the active one shown. Its tabs stand in the page
 * bar above it (`NodesHeaderTabs`).
 *
 * The pane with the keyboard sits on a lighter surface (`.mrx-node-pane` in
 * theme.css). Any click or focus inside gives it the keyboard, since a paste
 * has to know which side it lands on.
 */
export function NodePane({ index, pane, focused, names }: NodePaneProps) {
  useSignals();
  const tab = activeTabOf(pane);
  const user = currentUser.value;
  const showHidden = nodesWorkspace.value.showHidden;
  const focus = () => focusNodesPane(index);

  return (
    <div
      className='mrx-node-pane'
      data-focused={focused || undefined}
      onMouseDownCapture={focus}
      onFocusCapture={focus}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        flex: 1,
      }}
    >
      <Group gap={4} wrap='nowrap' p={4} style={{ background: 'var(--mrx-surface-raised)', borderBottom: '1px solid var(--mrx-hairline)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <NodeAddressBar
            path={tab.path}
            home={user ? homePath(user.username) : undefined}
            onNavigate={(path) => setNodesTabPath(index, tab.id, path)}
            onRefresh={() => invalidateListing(tab.path)}
          />
        </div>
        <SegmentedControl
          size='xs'
          value={tab.view}
          onChange={(value) => setNodesTabView(index, tab.id, value as ViewMode)}
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
            onClick={() => setNodesShowHidden(!showHidden)}
            aria-label='Show hidden'
            aria-pressed={showHidden}
          >
            {showHidden ? <IconEye size={16} /> : <IconEyeOff size={16} />}
          </ActionIcon>
        </Tooltip>
        {
          /* The details view sorts on its column names; the others have none. */
        }
        {tab.view !== 'details' && (
          <Menu shadow='md' withinPortal position='bottom-end'>
            <Menu.Target>
              <Tooltip label={`Sorted by ${SORT_LABELS[tab.sort.key].toLowerCase()}, ${tab.sort.dir === 'asc' ? 'ascending' : 'descending'}`} withArrow>
                <ActionIcon variant='subtle' color='gray' aria-label='Sort'>
                  <IconArrowsSort size={16} />
                </ActionIcon>
              </Tooltip>
            </Menu.Target>
            <Menu.Dropdown>
              {SORT_KEYS.map((key) => (
                <Menu.Item
                  key={key}
                  rightSection={tab.sort.key === key ? <IconCheck size={14} /> : undefined}
                  onClick={() => setNodesTabSort(index, tab.id, { key, dir: tab.sort.key === key ? (tab.sort.dir === 'asc' ? 'desc' : 'asc') : 'asc' })}
                >
                  {SORT_LABELS[key]}
                  {tab.sort.key === key ? (tab.sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
      {pane.tabs.map((each) => <NodeTabView key={each.id} pane={index} tab={each} active={each.id === tab.id} names={names} />)}
    </div>
  );
}
