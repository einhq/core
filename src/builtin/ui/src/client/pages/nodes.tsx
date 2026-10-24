import { Box } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { NodesExplorer, NodesHeaderTabs, NodesPageControls, PageBar } from '@ein/ui/components';
import { activeTabOf } from '@ein/ui/lib';
import { currentUser, nodesWorkspace, setNodesTabPath, startNodesAtHome } from '@ein/ui/signals';
import { homePath } from '@ein/paths';

/** The AppShell header. */
const HEADER = 'var(--app-shell-header-height)';

/**
 * The nodes explorer: every path in the system, as it is.
 *
 * The focused tab's path is mirrored to `?path=` so a location can be linked
 * to; the rest of the layout — tabs, split, views — is the person's own and
 * lives in local storage rather than the URL.
 */
export default function NodesPage() {
  useSignals();
  const [searchParams, setSearchParams] = useSearchParams();
  const workspace = nodesWorkspace.value;
  const focusedPane = workspace.panes[workspace.focused];
  const focusedTab = activeTabOf(focusedPane);

  // A first visit starts at home; an incoming `?path=` lands in the focused
  // tab, once, on arrival. Both wait for the user, whom the home is named after.
  const user = currentUser.value;
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || !user) return;
    applied.current = true;
    startNodesAtHome(homePath(user.username));
    const wanted = searchParams.get('path');
    if (wanted && wanted.startsWith('/')) setNodesTabPath(workspace.focused, focusedTab.id, wanted);
  }, [user, searchParams, focusedTab.id, workspace.focused]);

  useEffect(() => {
    if (!applied.current) return;
    if (searchParams.get('path') !== focusedTab.path) setSearchParams({ path: focusedTab.path }, { replace: true });
  }, [focusedTab.path, searchParams, setSearchParams]);

  // Edge to edge (its route is `fullBleed`): a file manager is a workspace, not
  // a document, and the margin and full header the other pages carry would only
  // cost it rows. The panes' and the tools' tabs stand on the bar's bottom edge,
  // over the columns they belong to.
  return (
    <Box
      style={{
        height: `calc(100dvh - ${HEADER})`,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--mrx-surface-base)',
      }}
    >
      <PageBar title='Nodes' pattern='mixed' controls={<NodesPageControls />} tabs={<NodesHeaderTabs />} flushTabs />
      <NodesExplorer />
    </Box>
  );
}
