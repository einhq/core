import { useSignals } from '@preact/signals-react/runtime';
import type { Identities } from '../../hooks/useIdentities.ts';
import type { NodeTab, PaneIndex } from '../../lib/nodes-workspace.ts';
import {
  nodesPropertiesPath,
  nodesReveal,
  nodesWorkspace,
  setNodesColumns,
  setNodesCurrent,
  setNodesProperties,
  setNodesShowHidden,
  setNodesTabPath,
  setNodesTabSort,
} from '../../signals/nodes.ts';
import { NodeListing } from './NodeListing.tsx';

type NodeTabViewProps = {
  pane: PaneIndex;
  tab: NodeTab;
  /** The pane's active tab — the one shown. */
  active: boolean;
  names: Identities;
};

/**
 * One tab of the Nodes page: its listing, bound to the page's workspace — the
 * tab's path, view and sort, the shared columns and dot names, the pane's
 * current row, the properties dialog and a tool's request to reveal a node.
 *
 * Kept mounted while another tab is in front, so switching back finds the
 * rows expanded as they were left; a tab that remounted on every switch
 * would be a bookmark, not a tab.
 */
export function NodeTabView({ pane, tab, active, names }: NodeTabViewProps) {
  useSignals();
  const workspace = nodesWorkspace.value;
  // A tool asked for a node to be shown in this tab (`revealNodeInNewTab`).
  const reveal = nodesReveal.value;

  return (
    <NodeListing
      path={tab.path}
      onNavigate={(path) => setNodesTabPath(pane, tab.id, path)}
      view={tab.view}
      sort={tab.sort}
      onSort={(sort) => setNodesTabSort(pane, tab.id, sort)}
      columns={workspace.columns}
      onColumns={setNodesColumns}
      showHidden={workspace.showHidden}
      onShowHidden={setNodesShowHidden}
      names={names}
      active={active}
      onCurrent={(current) => setNodesCurrent(pane, current)}
      onProperties={(path) => {
        nodesPropertiesPath.value = path;
        setNodesProperties(true);
      }}
      reveal={reveal?.tabId === tab.id ? reveal.path : null}
      onRevealed={() => nodesReveal.value = null}
    />
  );
}
