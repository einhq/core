import { Text } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { Fragment, type KeyboardEvent, type MouseEvent as ReactMouseEvent, useRef } from 'react';
import { useIdentities } from '../../hooks/useIdentities.ts';
import { activeTabOf, type PaneIndex } from '../../lib/nodes-workspace.ts';
import {
  focusNodesPane,
  nodesCurrent,
  nodesPropertiesOpen,
  nodesPropertiesPath,
  nodesWorkspace,
  setNodesProperties,
  setNodesSplit,
  setNodesToolsWidth,
} from '../../signals/nodes.ts';
import { paneColumn, PANES, ROW, separator, toolsColumn } from './columns.ts';
import { focusRow } from './focus-row.ts';
import { NodePane } from './NodePane.tsx';
import { NodeProperties } from './NodeProperties.tsx';
import { NodeToolPane } from './NodeToolPane.tsx';
import { Dialog } from '../Surface/Dialog.tsx';

/**
 * One pane, or two with a divider, and the tool pane to their right; the
 * properties of a node open in a dialog over them. The tabs of all three
 * stand in the page bar above (`NodesHeaderTabs`), laid out by the same
 * `columns.ts`.
 *
 * With two panes, Tab moves the keyboard to the other one, the one habit
 * from every two-pane file manager that a browser would otherwise take for
 * itself; it is caught only inside the explorer, so the page's own tab order
 * is intact outside it.
 */
export function NodesExplorer() {
  useSignals();
  const workspace = nodesWorkspace.value;
  const { names } = useIdentities();
  const container = useRef<HTMLDivElement>(null);
  const panes = useRef<HTMLDivElement>(null);

  // The tools are about the focused pane's current row, or that pane's directory.
  const current = nodesCurrent.value[workspace.focused];
  const subject = current?.path ?? activeTabOf(workspace.panes[workspace.focused]).path;

  const drag = (event: ReactMouseEvent, to: (moveEvent: MouseEvent, box: DOMRect) => void, of = panes) => {
    event.preventDefault();
    const box = of.current?.getBoundingClientRect();
    if (!box) return;
    const move = (moveEvent: MouseEvent) => to(moveEvent, box);
    const stop = () => {
      globalThis.removeEventListener('mousemove', move);
      globalThis.removeEventListener('mouseup', stop);
    };
    globalThis.addEventListener('mousemove', move);
    globalThis.addEventListener('mouseup', stop);
  };
  // The split is a share of the panes alone, so opening the tool pane keeps it.
  const startResize = (event: ReactMouseEvent) => drag(event, (moveEvent, box) => setNodesSplit((moveEvent.clientX - box.left) / box.width));
  const startToolsResize = (event: ReactMouseEvent) => drag(event, (moveEvent, box) => setNodesToolsWidth(box.right - moveEvent.clientX), container);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || event.ctrlKey || event.altKey || workspace.panes.length < 2) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [role=dialog]')) return;
    const other = workspace.focused === 0 ? 1 : 0;
    const pane = container.current?.querySelectorAll<HTMLElement>('[data-nodes-pane]')[other];
    const row = pane?.querySelector<HTMLElement>('[role=treeitem][data-selected]') ?? pane?.querySelector<HTMLElement>('[role=treeitem]');
    if (!row) return;
    event.preventDefault();
    focusNodesPane(other);
    focusRow(row);
  };

  const split = workspace.panes.length > 1;

  // Keyed by pane id, so closing the left pane moves the right one's trees
  // over rather than mounting them afresh with every expanded row folded.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div ref={container} onKeyDown={onKeyDown} style={{ ...ROW, flex: 1, minHeight: 0, position: 'relative' }}>
        <div ref={panes} style={{ ...PANES, minHeight: 0 }}>
          {workspace.panes.map((pane, at) => {
            const index = at as PaneIndex;
            return (
              <Fragment key={pane.id}>
                {index > 0 && <div onMouseDown={startResize} role='separator' aria-orientation='vertical' style={separator(true)} />}
                <div data-nodes-pane style={paneColumn(index, split, workspace.split)}>
                  <NodePane index={index} pane={pane} focused={workspace.focused === index} names={names} />
                </div>
              </Fragment>
            );
          })}
        </div>
        {workspace.tools.open && (
          <>
            <div onMouseDown={startToolsResize} role='separator' aria-orientation='vertical' aria-label='Resize tools' style={separator(true)} />
            <div style={toolsColumn(workspace.tools.width)}>
              <NodeToolPane path={subject} current={current} tool={workspace.tools.tool} names={names} />
            </div>
          </>
        )}
        <Dialog
          opened={nodesPropertiesOpen.value}
          onClose={() => setNodesProperties(false)}
          title='Properties'
          subtitle={nodesPropertiesPath.value && <Text span ff='monospace' size='sm' inherit>{nodesPropertiesPath.value}</Text>}
          icon='info-circle'
          pattern='system'
          size='xl'
        >
          {nodesPropertiesOpen.value && <NodeProperties path={nodesPropertiesPath.value} />}
        </Dialog>
      </div>
    </div>
  );
}
