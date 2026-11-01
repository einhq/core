import { useSignals } from '@preact/signals-react/runtime';
import type { Identities } from '../../hooks/useIdentities.ts';
import { activeTabOf, type PaneIndex, type PaneState } from '../../lib/nodes-workspace.ts';
import { focusNodesPane, nodesWorkspace, setNodesShowHidden, setNodesTabPath, setNodesTabSort, setNodesTabView } from '../../signals/nodes.ts';
import { NodePaneBar } from './NodePaneBar.tsx';
import { NodeTabView } from './NodeTabView.tsx';

type NodePaneProps = {
  index: PaneIndex;
  pane: PaneState;
  /** The pane with the keyboard; with one pane, always that one. */
  focused: boolean;
  names: Identities;
};

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
      <NodePaneBar
        path={tab.path}
        onNavigate={(path) => setNodesTabPath(index, tab.id, path)}
        view={tab.view}
        onView={(view) => setNodesTabView(index, tab.id, view)}
        showHidden={showHidden}
        onShowHidden={setNodesShowHidden}
        sort={tab.sort}
        onSort={(sort) => setNodesTabSort(index, tab.id, sort)}
      />
      {pane.tabs.map((each) => <NodeTabView key={each.id} pane={index} tab={each} active={each.id === tab.id} names={names} />)}
    </div>
  );
}
