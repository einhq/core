import { Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { type MouseEvent as ReactMouseEvent, type ReactNode, useRef, useState } from 'react';
import { useIdentities } from '../../hooks/useIdentities.ts';
import type { NodeChildEntry } from '../../lib/node-entry.ts';
import { DEFAULT_SORT, DEFAULT_TOOLS, type NodeSort, type ViewMode } from '../../lib/nodes-workspace.ts';
import { type NodesCurrent, nodesWorkspace } from '../../signals/nodes.ts';
import { Dialog } from '../Surface/Dialog.tsx';
import { PANES, ROW, separator, toolsColumn } from './columns.ts';
import { NodeListing } from './NodeListing.tsx';
import { NodePaneBar } from './NodePaneBar.tsx';
import { NodeProperties } from './NodeProperties.tsx';
import { NodeToolPane } from './NodeToolPane.tsx';

/** What a `NodeBrowser`'s side panel is about. */
export type NodeBrowserSubject = {
  /** The current row — the last to take the keyboard — or the directory when there is none. */
  path: string;
  /** The node's listing, or its `stat` as one; absent until known. */
  entry?: NodeChildEntry;
  /** The directory listed. */
  directory: string;
  /** The selected rows' paths. */
  selection: string[];
};

export type NodeBrowserProps = {
  /** The directory it opens in. */
  path: string;
  view?: ViewMode;
  /** At the top of the side panel, above the current node: what acts on the selection. */
  actions?: (subject: NodeBrowserSubject) => ReactNode;
  /** Below the current node's name, instead of its preview; the preview when it gives `undefined`. */
  details?: (subject: NodeBrowserSubject) => ReactNode;
};

/** Below this the side panel goes under the listing rather than beside it. */
const STACKED = '(max-width: 48em)';

/**
 * The Nodes page's pane on a page of its own: the address bar, the listing with
 * its keys, menu, drag and drop and rename, and a side panel about the current
 * row — its preview, or what the caller draws (`details`), under what the
 * caller offers for the selection (`actions`). It keeps its own place, view
 * and sort; the column widths start as the Nodes page has them.
 *
 * It fills its parent, which must give it a height.
 */
export function NodeBrowser({ path: start, view: startView = 'details', actions, details }: NodeBrowserProps) {
  const { names } = useIdentities();
  const [path, setPath] = useState(start);
  const [view, setView] = useState<ViewMode>(startView);
  const [sort, setSort] = useState<NodeSort>(DEFAULT_SORT);
  const [columns, setColumns] = useState(() => nodesWorkspace.value.columns);
  const [showHidden, setShowHidden] = useState(false);
  const [current, setCurrent] = useState<NodesCurrent | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [width, setWidth] = useState(DEFAULT_TOOLS.width);
  const [properties, setProperties] = useState<string | null>(null);
  const stacked = useMediaQuery(STACKED) ?? false;
  const row = useRef<HTMLDivElement>(null);

  const navigate = (to: string) => {
    setPath(to);
    setCurrent(null);
  };

  const startResize = (event: ReactMouseEvent) => {
    event.preventDefault();
    const box = row.current?.getBoundingClientRect();
    if (!box) return;
    const move = (moveEvent: MouseEvent) => setWidth(Math.max(200, box.right - moveEvent.clientX));
    const stop = () => {
      globalThis.removeEventListener('mousemove', move);
      globalThis.removeEventListener('mouseup', stop);
    };
    globalThis.addEventListener('mousemove', move);
    globalThis.addEventListener('mouseup', stop);
  };

  const subjectOf = (shown: string, entry?: NodeChildEntry): NodeBrowserSubject => ({
    path: shown,
    entry: entry ?? (current?.path === shown ? current.entry : undefined),
    directory: path,
    selection,
  });

  const side = (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', background: 'var(--mrx-surface-base)' }}>
      {actions && <div style={{ padding: 8, borderBottom: '1px solid var(--mrx-hairline)' }}>{actions(subjectOf(current?.path ?? path))}</div>}
      <NodeToolPane
        path={current?.path ?? path}
        current={current}
        tool='preview'
        names={names}
        onProperties={setProperties}
      >
        {details && ((shown, entry) => details(subjectOf(shown, entry)))}
      </NodeToolPane>
    </div>
  );

  return (
    <div
      ref={row}
      style={{ ...ROW, flex: 1, minHeight: 0, height: '100%', flexDirection: stacked ? 'column' : 'row' }}
    >
      <div className='mrx-node-pane' data-focused style={{ ...PANES, flexDirection: 'column', minHeight: 0, flex: 1 }}>
        <NodePaneBar
          path={path}
          onNavigate={navigate}
          view={view}
          onView={setView}
          showHidden={showHidden}
          onShowHidden={setShowHidden}
          sort={sort}
          onSort={setSort}
        />
        <NodeListing
          path={path}
          onNavigate={navigate}
          view={view}
          sort={sort}
          onSort={setSort}
          columns={columns}
          onColumns={setColumns}
          showHidden={showHidden}
          onShowHidden={setShowHidden}
          names={names}
          onCurrent={setCurrent}
          onSelection={setSelection}
          onProperties={setProperties}
        />
      </div>
      {stacked ? <div style={{ display: 'flex', flex: '0 0 45%', minHeight: 0, borderTop: '1px solid var(--mantine-color-default-border)' }}>{side}</div> : (
        <>
          <div onMouseDown={startResize} role='separator' aria-orientation='vertical' aria-label='Resize the side panel' style={separator(true)} />
          <div style={toolsColumn(width)}>{side}</div>
        </>
      )}
      <Dialog
        opened={properties !== null}
        onClose={() => setProperties(null)}
        title='Properties'
        subtitle={properties && <Text span ff='monospace' size='sm' inherit>{properties}</Text>}
        icon='info-circle'
        pattern='system'
        size='xl'
      >
        {properties !== null && <NodeProperties path={properties} />}
      </Dialog>
    </div>
  );
}
