import { effect, signal } from '@preact/signals-react';
import type { NodeChildEntry } from '../lib/node-entry.ts';
import { parentPath } from '../lib/node-path.ts';
import {
  activeTabOf,
  addTab as addTabIn,
  closePane as closePaneIn,
  closeTab as closeTabIn,
  defaultWorkspace,
  newPane,
  newTab,
  NODES_WORKSPACE_KEY,
  type NodeSort,
  type NodesWorkspace,
  type NodeTab,
  type NodeTool,
  openPane as openPaneIn,
  type PaneIndex,
  parseNodesWorkspace,
  setActiveTab as setActiveTabIn,
  setColumns as setColumnsIn,
  setFocused as setFocusedIn,
  setShowHidden as setShowHiddenIn,
  setSplit as setSplitIn,
  setTabPath as setTabPathIn,
  setTabSort as setTabSortIn,
  setTabView as setTabViewIn,
  setTool as setToolIn,
  setToolsOpen as setToolsOpenIn,
  setToolsWidth as setToolsWidthIn,
  type ViewMode,
} from '../lib/nodes-workspace.ts';
import { shq } from '../lib/shquote.ts';
import { execCommand } from './shell-client.ts';

/**
 * The nodes explorer's state: the workspace (persisted), the clipboard and the
 * listing cache (not).
 *
 * Held in signals rather than page state because two panes are siblings
 * that act on each other — a drop on the right pane changes what the left one
 * shows — and because the workspace has to outlive the page: leaving for an
 * album and coming back should find the tabs where they were.
 */

function loadWorkspace(): NodesWorkspace {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = parseNodesWorkspace(localStorage.getItem(NODES_WORKSPACE_KEY));
      if (stored) return stored;
    }
  } catch {
    // Storage may be disabled; the explorer still works for this page.
  }
  return defaultWorkspace();
}

export const nodesWorkspace = signal<NodesWorkspace>(loadWorkspace());

/**
 * Point a first visit at `home`.
 *
 * The default workspace is made before anyone is logged in, so it starts at
 * `/`; once the user is known, a workspace nobody has touched yet — every
 * pane on one tab at the root — moves to their home directory instead.
 * A workspace that has been used is left alone.
 */
export function startNodesAtHome(home: string): void {
  const ws = nodesWorkspace.value;
  const untouched = ws.panes.every((pane) => pane.tabs.length === 1 && pane.tabs[0].path === '/');
  if (!untouched) return;
  let next = ws;
  ws.panes.forEach((pane, index) => next = setTabPathIn(next, index as PaneIndex, pane.tabs[0].id, home));
  nodesWorkspace.value = next;
}

effect(() => {
  const workspace = nodesWorkspace.value;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(NODES_WORKSPACE_KEY, JSON.stringify(workspace));
  } catch {
    // Storage may be disabled or full; the explorer still works for this page.
  }
});

export const addNodesTab = (pane: PaneIndex, path: string, view?: ViewMode, sort?: NodeSort): NodeTab => {
  const tab = newTab(path, view, sort);
  nodesWorkspace.value = addTabIn(nodesWorkspace.value, pane, tab);
  return tab;
};
/**
 * A node for a tab to select once its listing has the row: set by
 * `revealNodeInNewTab`, taken and cleared by the tab it names.
 */
export const nodesReveal = signal<{ tabId: string; path: string } | null>(null);
/**
 * Show a node among its siblings in a new tab beside the focused pane's
 * active one, with the node selected — for a tool's result, which should not
 * move the tab the tool was run from. With the pane full of tabs, the active
 * tab goes there instead.
 */
export const revealNodeInNewTab = (path: string) => {
  const ws = nodesWorkspace.value;
  const from = activeTabOf(ws.panes[ws.focused]);
  const tab = addNodesTab(ws.focused, parentPath(path), from.view, from.sort);
  const added = nodesWorkspace.value.panes[ws.focused].tabs.some((each) => each.id === tab.id);
  if (!added) setNodesTabPath(ws.focused, from.id, parentPath(path));
  nodesReveal.value = { tabId: added ? tab.id : from.id, path };
};
/** A second pane, opened where the focused tab is and viewed the same way. */
export const openNodesPane = () => {
  const ws = nodesWorkspace.value;
  const from = activeTabOf(ws.panes[ws.focused]);
  nodesWorkspace.value = openPaneIn(ws, newPane(newTab(from.path, from.view, from.sort)));
};
export const closeNodesPane = (pane: PaneIndex) => {
  const before = nodesWorkspace.value;
  nodesWorkspace.value = closePaneIn(before, pane);
  // The surviving pane republishes its row as pane 0; slot 1 would be a leftover.
  if (nodesWorkspace.value !== before) setNodesCurrent(1, null);
};
export const closeNodesTab = (pane: PaneIndex, tabId: string) => {
  nodesWorkspace.value = closeTabIn(nodesWorkspace.value, pane, tabId);
};
export const activateNodesTab = (pane: PaneIndex, tabId: string) => {
  nodesWorkspace.value = setActiveTabIn(nodesWorkspace.value, pane, tabId);
};
export const setNodesTabPath = (pane: PaneIndex, tabId: string, path: string) => {
  nodesWorkspace.value = setTabPathIn(nodesWorkspace.value, pane, tabId, path);
};
export const setNodesTabView = (pane: PaneIndex, tabId: string, view: ViewMode) => {
  nodesWorkspace.value = setTabViewIn(nodesWorkspace.value, pane, tabId, view);
};
export const setNodesTabSort = (pane: PaneIndex, tabId: string, sort: NodeSort) => {
  nodesWorkspace.value = setTabSortIn(nodesWorkspace.value, pane, tabId, sort);
};
export const setNodesSplit = (split: number) => {
  nodesWorkspace.value = setSplitIn(nodesWorkspace.value, split);
};
export const focusNodesPane = (pane: PaneIndex) => {
  nodesWorkspace.value = setFocusedIn(nodesWorkspace.value, pane);
};
export const setNodesColumns = (columns: number[]) => {
  nodesWorkspace.value = setColumnsIn(nodesWorkspace.value, columns);
};
export const setNodesShowHidden = (showHidden: boolean) => {
  nodesWorkspace.value = setShowHiddenIn(nodesWorkspace.value, showHidden);
};
export const setNodesToolsOpen = (open: boolean) => {
  nodesWorkspace.value = setToolsOpenIn(nodesWorkspace.value, open);
};
export const setNodesToolsWidth = (width: number) => {
  nodesWorkspace.value = setToolsWidthIn(nodesWorkspace.value, width);
};
export const setNodesTool = (tool: NodeTool) => {
  nodesWorkspace.value = setToolIn(nodesWorkspace.value, tool);
};

/**
 * The row each pane's active tab is on, for the tool pane, with that
 * tab's own way of opening it — the lightbox wants the directory's other
 * media, which only the tab's tree has. `null` means the tab's directory
 * itself. A moment's state, like the selection it follows.
 */
export type NodesCurrent = {
  path: string;
  /** The row's listing, which carries the child count `stat` does not. */
  entry: NodeChildEntry;
  open: (() => void) | null;
  /** How many rows the tab has selected. */
  selected: number;
};
export const nodesCurrent = signal<[NodesCurrent | null, NodesCurrent | null]>([null, null]);
export const setNodesCurrent = (pane: PaneIndex, current: NodesCurrent | null) => {
  const slots = nodesCurrent.value;
  const was = slots[pane];
  const same = was && current && was.path === current.path && was.entry === current.entry && was.open === current.open && was.selected === current.selected;
  if (was === current || same) return;
  const next: [NodesCurrent | null, NodesCurrent | null] = [slots[0], slots[1]];
  next[pane] = current;
  nodesCurrent.value = next;
};

/** Whether the properties dialog is open — a moment's state, not part of the saved workspace. */
export const nodesPropertiesOpen = signal(false);
export const setNodesProperties = (shown: boolean) => {
  nodesPropertiesOpen.value = shown;
};

/**
 * Cut or copied paths, waiting for a paste.
 *
 * Internal to the app: a node path on the system clipboard would mean nothing
 * to any other program, and reading the system clipboard needs a permission
 * prompt for no gain.
 */
export type NodeClipboard = { mode: 'copy' | 'cut'; paths: string[] };
export const nodeClipboard = signal<NodeClipboard | null>(null);

/**
 * What is being dragged, while it is.
 *
 * A drag's `dataTransfer` is readable on drop only — during `dragover` the
 * browser hides its contents — so whether a row may accept the drag has to be
 * answered from here. Cleared on drop and on drag end.
 */
export const nodeDragPaths = signal<string[]>([]);

/** The node the properties dialog is about. */
export const nodesPropertiesPath = signal<string | null>(null);

/**
 * Directory listings, shared across every tree that shows the same directory.
 *
 * Both panes on `/archive/albums` is the normal case, not the exception, and
 * so is a tab expanding a directory the other tab already lists. One in-flight
 * command per path serves all of them; the result is not kept after that,
 * because every tree already keeps what it shows, and a listing older than
 * the tree is a listing the events would have replaced.
 */
const inFlight = new Map<string, Promise<NodeChildEntry[]>>();

export function listNodes(path: string): Promise<NodeChildEntry[]> {
  let pending = inFlight.get(path);
  if (!pending) {
    // `-A` for dotfiles without `.`/`..`; `-L` lists a softlink as itself
    // (it means readlink here, the reverse of GNU ls).
    pending = execCommand<NodeChildEntry[]>(`ls -lAL ${shq(path)}`).finally(() => inFlight.delete(path));
    inFlight.set(path, pending);
  }
  return pending;
}

/**
 * Bumped for a directory after any write the explorer made under it, so every
 * tree showing that directory reloads at once — the event for the change will
 * arrive too, but a paste that takes a second to show is a paste that gets
 * clicked twice.
 */
export const listingVersion = signal<Map<string, number>>(new Map());

export function invalidateListing(...paths: string[]): void {
  const next = new Map(listingVersion.value);
  for (const path of paths) next.set(path, (next.get(path) ?? 0) + 1);
  listingVersion.value = next;
}
