import { ActionIcon, Alert, Group, Loader, Stack, Text, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconAlertTriangle, IconExternalLink, IconInfoCircle } from '@tabler/icons-react';
import { useSignals } from '@preact/signals-react/runtime';
import { useEffect, useRef } from 'react';
import type { Identities } from '../../hooks/useIdentities.ts';
import { useNodeStat } from '../../hooks/useNodeStat.ts';
import type { NodeChildEntry } from '../../lib/node-entry.ts';
import { baseName, parentPath } from '../../lib/node-path.ts';
import type { NodeTool } from '../../lib/nodes-workspace.ts';
import { panelRoute, panelsOf } from '../../signals/nav.ts';
import { listingVersion, type NodesCurrent, nodesPropertiesPath, setNodesProperties } from '../../signals/nodes.ts';
import { RoutePanel } from '../Surface/SurfaceRouter.tsx';
import { SharePanel } from '../Share/ShareModal.tsx';
import { NodeAttributes } from './NodeAttributes.tsx';
import { NodeIcon } from './NodeIcon.tsx';
import { NodePreview } from './NodePreview.tsx';

/** How long the row must stay put before it is loaded: arrowing down a listing should not `stat` every row it passes. */
const SETTLE_MS = 150;

type NodeToolPaneProps = {
  /** The node the tools are about: the focused tab's current row, or its directory. */
  path: string;
  current: NodesCurrent | null;
  tool: NodeTool;
  names: Identities;
};

/**
 * The right-hand pane: tools about what the focused pane has selected — its
 * current row, or the tab's own directory when no row is. Which tool shows is
 * chosen by the tabs over it in the page bar (`NodesHeaderTabs`).
 *
 * The pane has no header of its own; the first line of its body names the
 * node the tool is about, with its Open and Properties, and scrolls with the
 * rest.
 */
export function NodeToolPane({ path, current, tool, names }: NodeToolPaneProps) {
  useSignals();
  const [settled] = useDebouncedValue(path, SETTLE_MS);
  const { stat, statPath, loading, error, refetch } = useNodeStat(settled);

  // The explorer's own writes bump the parent's listing; a chmod or an edit
  // seen here should not wait for the row to be reselected.
  const parentVersion = listingVersion.value.get(parentPath(settled));
  const seen = useRef(parentVersion);
  useEffect(() => {
    if (seen.current === parentVersion) return;
    seen.current = parentVersion;
    refetch();
  }, [parentVersion, refetch]);

  // The listing's entry when there is one, since it is already here and knows
  // the child count; otherwise `stat` as an entry — the tab's own directory.
  const listed = current?.path === settled ? current.entry : undefined;
  const entry: NodeChildEntry | undefined = listed ??
    (stat ? { node: stat.node as NodeChildEntry['node'], name: baseName(settled) || '/', childCount: -1 } : undefined);

  // A module's tool is its route, given the row's path; one that is gone shows the preview.
  const panel = panelsOf('nodes.tools').find((each) => each.id === tool);
  const shown = panel || ['attributes', 'sharing'].includes(tool) ? tool : 'preview';

  const showProperties = () => {
    nodesPropertiesPath.value = settled;
    setNodesProperties(true);
  };

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', padding: 8, background: 'var(--mrx-surface-base)' }}>
      <Stack gap='sm'>
        <Group gap={6} wrap='nowrap'>
          {entry && <NodeIcon entry={entry} path={settled} size={20} />}
          <Text size='sm' fw={600} ff='monospace' truncate style={{ flex: 1, minWidth: 0 }} title={settled}>{baseName(settled) || '/'}</Text>
          {current?.path === settled && current.open && (
            <Tooltip label='Open' withArrow>
              <ActionIcon variant='subtle' color='gray' onClick={current.open} aria-label='Open'>
                <IconExternalLink size={16} />
              </ActionIcon>
            </Tooltip>
          )}
          <Tooltip label='Properties' withArrow>
            <ActionIcon variant='subtle' color='gray' onClick={showProperties} aria-label='Properties'>
              <IconInfoCircle size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
        {current && current.selected > 1 && <Text size='xs' c='dimmed'>{current.selected} selected; showing the current row.</Text>}
        {error && (
          <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />}>
            {error.message}
          </Alert>
        )}
        {loading && !stat && !entry && <Loader size='sm' />}
        {shown === 'preview' && <NodePreview path={settled} entry={entry} stat={stat} names={names} />}
        {
          /* Only this node's own `stat`: the one before it stays while this loads, and saving that would write it here. */
        }
        {shown === 'attributes' && <NodeAttributes key={settled} path={settled} stat={statPath === settled ? stat : null} refetch={refetch} />}
        {panel && <RoutePanel path={panelRoute(panel, settled)} />}
        {shown === 'sharing' && <SharePanel path={settled} enabled />}
      </Stack>
    </div>
  );
}
