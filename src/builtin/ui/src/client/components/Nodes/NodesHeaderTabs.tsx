import { IconBraces, IconEye, IconShare } from '@tabler/icons-react';
import { useSignals } from '@preact/signals-react/runtime';
import { Fragment, type ReactNode } from 'react';
import { activeTabOf, type NodeTool, type PaneIndex } from '../../lib/nodes-workspace.ts';
import { panelsOf } from '../../signals/nav.ts';
import { activateNodesTab, addNodesTab, closeNodesPane, closeNodesTab, focusNodesPane, nodesWorkspace, setNodesTool } from '../../signals/nodes.ts';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import { paneColumn, PANES, ROW, separator, toolsColumn } from './columns.ts';
import { NodeTabStrip } from './NodeTabStrip.tsx';

type ToolTab = { value: NodeTool; label: string; icon: ReactNode };

/** The shell's own tools around the modules' (`nodes.tools` panels), which sit between them. */
const toolTabs = (): ToolTab[] => [
  { value: 'preview', label: 'Preview', icon: <IconEye size={16} /> },
  { value: 'attributes', label: 'Attributes', icon: <IconBraces size={16} /> },
  ...panelsOf('nodes.tools').map((panel) => ({ value: panel.id, label: panel.label, icon: <TablerIcon name={panel.icon ?? 'puzzle'} size={16} /> })),
  { value: 'sharing', label: 'Sharing', icon: <IconShare size={16} /> },
];

/**
 * The explorer's tabs, for the page bar's bottom edge: each pane's over that
 * pane and, when the tool pane is open, its tools over it — the same columns
 * as the body below (`columns.ts`), so a tab opens into the listing it names.
 * A click on a pane's strip gives that pane the keyboard, as a click in the
 * pane itself does.
 */
export function NodesHeaderTabs() {
  useSignals();
  const workspace = nodesWorkspace.value;
  const split = workspace.panes.length > 1;

  return (
    <div className='mrx-nodes-header-tabs' style={ROW}>
      <div style={PANES}>
        {workspace.panes.map((pane, at) => {
          const index = at as PaneIndex;
          const tab = activeTabOf(pane);
          return (
            <Fragment key={pane.id}>
              {index > 0 && <div style={separator(false)} />}
              <div style={paneColumn(index, split, workspace.split)} onMouseDownCapture={() => focusNodesPane(index)}>
                <NodeTabStrip
                  tabs={pane.tabs}
                  activeTabId={pane.activeTabId}
                  onActivate={(tabId) => activateNodesTab(index, tabId)}
                  onClose={(tabId) => closeNodesTab(index, tabId)}
                  onAdd={() => addNodesTab(index, tab.path, tab.view, tab.sort)}
                  onClosePane={split ? () => closeNodesPane(index) : undefined}
                />
              </div>
            </Fragment>
          );
        })}
      </div>
      {workspace.tools.open && (
        <>
          <div style={separator(false)} />
          <div style={toolsColumn(workspace.tools.width)}>
            <div className='mrx-nodes-tabs' data-tools>
              <div className='mrx-nodes-tabs-scroll' role='tablist' aria-label='Tools'>
                {toolTabs().map((tool) => {
                  const active = workspace.tools.tool === tool.value;
                  return (
                    <div
                      key={tool.value}
                      className='mrx-nodes-tab'
                      role='tab'
                      aria-selected={active}
                      aria-label={tool.label}
                      title={tool.label}
                      data-active={active || undefined}
                      onClick={() => setNodesTool(tool.value)}
                    >
                      {tool.icon}
                      <span className='mrx-nodes-tab-label'>{tool.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
