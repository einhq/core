import { Button, Tooltip } from '@mantine/core';
import { IconLayoutColumns, IconLayoutSidebarRight } from '@tabler/icons-react';
import { useSignals } from '@preact/signals-react/runtime';
import { MAX_PANES, type PaneIndex } from '../../lib/nodes-workspace.ts';
import { closeNodesPane, nodesWorkspace, openNodesPane, setNodesToolsOpen } from '../../signals/nodes.ts';

/**
 * The nodes page's controls, for the right of its `PageBar`: what acts on the
 * whole workspace rather than on one tab. A toggle shows its state by being
 * filled in, so the bar also reads as a summary of the layout.
 */
export function NodesPageControls() {
  useSignals();
  const workspace = nodesWorkspace.value;
  const split = workspace.panes.length >= MAX_PANES;
  // Unsplitting keeps the pane being worked in and closes the other one.
  const toggleSplit = () => split ? closeNodesPane((workspace.focused === 0 ? 1 : 0) as PaneIndex) : openNodesPane();
  const toolsOpen = workspace.tools.open;

  return (
    <>
      <Tooltip label={split ? 'Close the other pane' : 'Open a second pane beside this one'} withArrow>
        <Button
          size='compact-sm'
          variant={split ? 'filled' : 'light'}
          leftSection={<IconLayoutColumns size={16} />}
          onClick={toggleSplit}
          aria-pressed={split}
        >
          Split
        </Button>
      </Tooltip>
      <Tooltip label={toolsOpen ? 'Hide the tools' : 'Show the preview and other tools'} withArrow>
        <Button
          size='compact-sm'
          variant={toolsOpen ? 'filled' : 'light'}
          leftSection={<IconLayoutSidebarRight size={16} />}
          onClick={() => setNodesToolsOpen(!toolsOpen)}
          aria-pressed={toolsOpen}
        >
          Tools
        </Button>
      </Tooltip>
    </>
  );
}
