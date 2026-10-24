import { Alert } from '@mantine/core';
import { IconAlertTriangle, IconLock } from '@tabler/icons-react';
import { useSignals } from '@preact/signals-react/runtime';
import { type DragEvent, type FocusEvent, type KeyboardEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccessIds } from '../../hooks/useAccessIds.ts';
import { canList, describeNodeError, isGuest } from '../../lib/access.ts';
import type { Identities } from '../../hooks/useIdentities.ts';
import { useNodeOps } from '../../hooks/useNodeOps.ts';
import { useNodeTree } from '../../hooks/useNodeTree.ts';
import { useShortcutHelp } from '../../hooks/useShortcutHelp.ts';
import { GRID_KEYS, type GridKey, gridNeighbour } from '../../lib/grid-nav.ts';
import { mediaItemFrom } from '../../lib/media-item.ts';
import { hasRenditions, isMediaFile, type NodeChildEntry, toMillis } from '../../lib/node-entry.ts';
import { baseName, dropAllowed, joinPath, parentPath } from '../../lib/node-path.ts';
import { openTargetFor } from '../../lib/node-route.ts';
import { shq } from '../../lib/shquote.ts';
import type { NodeTab, PaneIndex } from '../../lib/nodes-workspace.ts';
import { openMediaAt } from '../../signals/album.ts';
import { openCodeEditor } from '../../signals/code-editor.ts';
import { openTerminalTab } from '../../signals/terminal.ts';
import {
  invalidateListing,
  nodeClipboard,
  nodeDragPaths,
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
import { type ContextMenuState, NodeContextMenu } from './NodeContextMenu.tsx';
import { type NodeDialog, NodeDialogs } from './NodeDialogs.tsx';
import { setDragChip } from '../../lib/drag-chip.ts';
import { focusRow, revealRow } from './focus-row.ts';
import type { RowDragHandlers } from './NodeRow.tsx';
import { NodeTree } from './NodeTree.tsx';

const DRAG_MIME = 'application/x-ein-nodes';

type NodeTabViewProps = {
  pane: PaneIndex;
  tab: NodeTab;
  /** The pane's active tab — the one shown. */
  active: boolean;
  names: Identities;
};

const NODE_SHORTCUTS = [
  { keys: 'Enter', label: 'Go into the row' },
  { keys: 'alt+Enter', label: 'Properties' },
  { keys: 'Backspace', label: 'Up a level' },
  { keys: 'F2', label: 'Rename' },
  { keys: 'Delete', label: 'Delete' },
  { keys: 'F5', label: 'Reload' },
  { keys: 'mod+H', label: 'Show or hide dot names' },
  { keys: 'mod+C', label: 'Copy' },
  { keys: 'mod+X', label: 'Cut' },
  { keys: 'mod+V', label: 'Paste' },
];

/**
 * One tab: its tree and everything that acts on it.
 *
 * Kept mounted while another tab is in front, so switching back finds the
 * rows expanded as they were left; a tab that remounted on every switch
 * would be a bookmark, not a tab.
 */
export function NodeTabView({ pane, tab, active, names }: NodeTabViewProps) {
  useShortcutHelp('Nodes', NODE_SHORTCUTS);
  useSignals();
  const showHidden = nodesWorkspace.value.showHidden;
  const state = useNodeTree(tab.path, tab.sort, showHidden);
  const ops = useNodeOps();
  const access = useAccessIds();
  const routerNavigate = useNavigate();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<NodeDialog | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  /** A renamed row to give the keyboard back to once the listing shows it under its new name. */
  const focusAfterReload = useRef<string | null>(null);

  const { tree, entryAt, entriesOf, reload, data } = state;
  const selection = tree.selectedState;
  const clipboard = nodeClipboard.value;
  const cutPaths = useMemo(() => new Set(clipboard?.mode === 'cut' ? clipboard.paths : []), [clipboard]);
  // The server decides for real; this only keeps a guest from being offered writes.
  const writable = access !== null && !isGuest(access);

  const navigate = useCallback((path: string) => setNodesTabPath(pane, tab.id, path), [pane, tab.id]);

  // Going into a row the reader may not list would only swap the listing for
  // an error; the row stays, and the reason is said above it.
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => setRefused(null), [tab.path]);
  const drill = useCallback((path: string) => {
    const entry = entryAt(path);
    if (entry && !canList(entry.node.props, access)) setRefused(`You do not have permission to open ${entry.name}.`);
    else navigate(path);
  }, [entryAt, access, navigate]);

  // The icons view has no in-place expansion: tiles wrap, and a subtree inside
  // a tile would break the flow.
  useEffect(() => {
    if (tab.view === 'icons') tree.setExpandedState({});
  }, [tab.view]);

  const selectedEntries = useCallback((): { entry: NodeChildEntry; path: string }[] =>
    selection.flatMap((path) => {
      const entry = entryAt(path);
      return entry ? [{ entry, path }] : [];
    }), [selection, entryAt]);

  const open = useCallback((path: string) => {
    const entry = entryAt(path);
    if (!entry) return;
    const target = openTargetFor(entry, path, access);
    if (target.kind === 'route') routerNavigate(target.to);
    else if (target.kind === 'file') globalThis.open(target.url, '_blank', 'noopener');
    else if (target.kind === 'editor') openCodeEditor({ kind: 'file', path, readOnly: target.readOnly, mimetype: entry.node.attrs.mimetype });
    else if (target.kind === 'lightbox') {
      // The directory's other media come along so the arrows walk the folder.
      const siblings = (entriesOf(parentPath(path)) ?? []).filter(isMediaFile);
      const items = siblings.map((sibling) => {
        const siblingPath = joinPath(parentPath(path), sibling.name);
        const { attrs } = sibling.node;
        return mediaItemFrom({
          path: siblingPath,
          name: sibling.name,
          mimetype: attrs.mimetype,
          width: attrs.width,
          height: attrs.height,
          sar: attrs.sar,
          angle: attrs.angle,
          duration: attrs.duration,
          hasDerivatives: hasRenditions(sibling),
          takenAt: toMillis(sibling.node.props.modtime?.timestamp) !== undefined ? new Date(toMillis(sibling.node.props.modtime.timestamp)!).toISOString() : undefined,
        });
      });
      const index = Math.max(0, items.findIndex((item) => item.path === path));
      openMediaAt(index, items);
    }
  }, [entryAt, entriesOf, routerNavigate, access]);

  // Rows that were hidden away do not stay selected out of sight, where a
  // delete or a cut would still take them.
  useEffect(() => {
    if (showHidden) return;
    const shown = tree.selectedState.filter((path) => !baseName(path).startsWith('.'));
    if (shown.length !== tree.selectedState.length) tree.setSelectedState(shown);
  }, [showHidden]);

  // The row the tool pane is about: the last one to take the keyboard, which a
  // click does too, so arrowing through the tree previews as it goes. With the
  // selection cleared, it is the tab's directory again.
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => setCurrent(null), [tab.path]);
  useEffect(() => {
    if (selection.length === 1) setCurrent(selection[0]);
    else if (selection.length === 0) setCurrent(null);
  }, [selection]);
  // The arrow keys move the selection, not just the keyboard: Mantine's tree
  // only moves focus, marking the row it moved to with `data-focus-ring`, which
  // a click never sets. Shift extends the selection (the tree does that) and
  // Ctrl moves without selecting, so rows can still be picked one by one.
  const navKeys = useRef({ shift: false, ctrl: false, scrollLeft: 0 });
  const onKeyDownCapture = (event: KeyboardEvent) => {
    const area = root.current?.querySelector<HTMLElement>('[data-nodes-area]');
    navKeys.current = { shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey, scrollLeft: area?.scrollLeft ?? 0 };
    if (tab.view === 'icons') moveInGrid(event);
  };

  // The icons view wraps its tiles into rows, which the tree does not know:
  // its Down is the next tile and its Left and Right collapse and expand. Here
  // the arrows move by the layout on screen instead, caught before the tree's
  // own handler on the row sees them.
  const moveInGrid = (event: KeyboardEvent) => {
    if (!GRID_KEYS.has(event.key) || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable]')) return;
    const from = target.closest<HTMLElement>('[role=treeitem]');
    const tiles = [...root.current?.querySelectorAll<HTMLElement>('[role=treeitem]') ?? []];
    const index = from ? tiles.indexOf(from) : -1;
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();

    const boxes = tiles.map((tile) => {
      const box = tile.getBoundingClientRect();
      return { left: box.left, top: box.top, width: box.width };
    });
    const next = gridNeighbour(boxes, index, event.key as GridKey);
    if (next === null) return;
    const to = tiles[next];

    // Shift extends from the anchor as the tree's own Shift+Down does; the
    // plain move selects on focus, below, and Ctrl moves without selecting.
    if (event.shiftKey) {
      const values = tiles.map((tile) => tile.dataset.value ?? '');
      const anchorAt = tree.anchorNode ? values.indexOf(tree.anchorNode) : -1;
      const start = anchorAt < 0 ? index : anchorAt;
      tree.setSelectedState(values.slice(Math.min(start, next), Math.max(start, next) + 1));
    }
    to.setAttribute('data-focus-ring', 'true');
    focusRow(to);
  };
  const onFocus = (event: FocusEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[role=treeitem]');
    const path = row?.dataset.value;
    if (!path) return;
    setCurrent(path);
    if (!row.hasAttribute('data-focus-ring')) return;
    // The tree focuses the next row without `preventScroll` (focus-row.ts says
    // why that hurts): put the sideways scroll back and reveal the row ourselves,
    // below the sticky header the browser's own scrolling ignores.
    const area = root.current?.querySelector<HTMLElement>('[data-nodes-area]');
    if (area) area.scrollLeft = navKeys.current.scrollLeft;
    revealRow(row);
    if (!navKeys.current.shift && !navKeys.current.ctrl) {
      tree.select(path);
      tree.setSelectedState([path]);
    }
  };

  const currentEntry = current ? entryAt(current) : undefined;
  const openCurrent = useMemo(
    () => current && currentEntry && openTargetFor(currentEntry, current, access).kind !== 'none' ? () => open(current) : null,
    [current, currentEntry, access, open],
  );
  useEffect(() => {
    if (!active) return;
    // A row that has gone — deleted or renamed — leaves the directory itself.
    setNodesCurrent(pane, current && currentEntry ? { path: current, entry: currentEntry, open: openCurrent, selected: selection.length } : null);
  }, [active, pane, current, currentEntry, openCurrent, selection.length]);

  const showProperties = useCallback((path: string) => {
    nodesPropertiesPath.value = path;
    setNodesProperties(true);
  }, []);

  const copyToClipboard = useCallback((mode: 'copy' | 'cut') => {
    if (selection.length > 0) nodeClipboard.value = { mode, paths: [...selection] };
  }, [selection]);

  const askDelete = useCallback(() => {
    const entries = selectedEntries();
    if (entries.length === 0) return;
    setDialog({ kind: 'delete', paths: entries.map((item) => item.path), nonEmpty: entries.filter((item) => item.entry.childCount > 0).length });
  }, [selectedEntries]);

  const askRename = useCallback(() => {
    if (writable && selection.length === 1) setRenaming(selection[0]);
  }, [writable, selection]);

  const rowElement = (path: string) => root.current?.querySelector<HTMLElement>(`[role=treeitem][data-value="${CSS.escape(path)}"]`);

  // The field held the keyboard; give it back to the row, as it was before F2.
  const cancelRename = useCallback((path: string) => {
    setRenaming(null);
    focusRow(rowElement(path));
  }, []);

  // The field stays, read-only with the new name, until the reloaded listing
  // has the row under that name; ending it at once would flash the old one.
  const commitRename = useCallback(async (path: string, name: string) => {
    if (!await ops.rename(path, name)) {
      cancelRename(path);
      return;
    }
    const renamed = joinPath(parentPath(path), name);
    focusAfterReload.current = renamed;
    tree.setSelectedState([renamed]);
  }, [ops.rename, tree, cancelRename]);

  // Leaving the directory abandons a rename; coming back must not find the field still open.
  useEffect(() => {
    setRenaming(null);
    focusAfterReload.current = null;
  }, [tab.path]);

  // A tool asked for a node to be shown here (`revealNodeInNewTab`); select it
  // once the listing has the row.
  const reveal = nodesReveal.value;
  useEffect(() => {
    if (!reveal || reveal.tabId !== tab.id) return;
    const row = rowElement(reveal.path);
    if (!row) return;
    nodesReveal.value = null;
    tree.select(reveal.path);
    tree.setSelectedState([reveal.path]);
    focusRow(row);
  }, [reveal, data, tab.id]);

  useEffect(() => {
    const path = focusAfterReload.current;
    if (!path) return;
    const row = rowElement(path);
    if (!row) return;
    focusAfterReload.current = null;
    setRenaming(null);
    focusRow(row);
  }, [data]);

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable]')) return;
    const focusedPath = target.closest<HTMLElement>('[role=treeitem]')?.dataset.value;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (event.key === 'Enter' && event.altKey) {
      if (focusedPath) showProperties(focusedPath);
    } else if (event.key === 'Enter') {
      if (focusedPath) drill(focusedPath);
    } else if (event.key === 'Backspace') {
      navigate(parentPath(tab.path));
    } else if (event.key === 'F2') {
      askRename();
    } else if (event.key === 'Delete') {
      if (writable) askDelete();
    } else if (event.key === 'F5') {
      invalidateListing(tab.path);
    } else if (ctrl && key === 'h') {
      setNodesShowHidden(!showHidden);
    } else if (ctrl && key === 'a') {
      const all: string[] = [];
      const walk = (nodes: typeof data) => {
        for (const node of nodes) {
          all.push(node.value);
          if (tree.expandedState[node.value] && node.children) walk(node.children);
        }
      };
      walk(data);
      tree.setSelectedState(all);
    } else if (ctrl && key === 'c') {
      copyToClipboard('copy');
    } else if (ctrl && key === 'x') {
      if (writable) copyToClipboard('cut');
    } else if (ctrl && key === 'v') {
      if (writable) ops.paste(tab.path);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const drag: RowDragHandlers = {
    onDragStart: (event: DragEvent, path: string) => {
      const paths = selection.includes(path) ? [...selection] : [path];
      nodeDragPaths.value = paths;
      event.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths));
      event.dataTransfer.setData('text/plain', paths.join('\n'));
      event.dataTransfer.effectAllowed = 'copyMove';
      // The dragged row's name, and how many more of the selection come with it.
      setDragChip(event, event.currentTarget as HTMLElement, baseName(path), paths.length - 1);
    },
    onDragOver: (event: DragEvent, target: string) => {
      if (!event.dataTransfer.types.includes(DRAG_MIME)) return false;
      if (!writable || !dropAllowed(nodeDragPaths.value, target)) return false;
      event.preventDefault();
      event.dataTransfer.dropEffect = event.ctrlKey ? 'copy' : 'move';
      return true;
    },
    onDrop: (event: DragEvent, target: string) => {
      event.preventDefault();
      event.stopPropagation();
      const raw = event.dataTransfer.getData(DRAG_MIME);
      const paths: string[] = raw ? JSON.parse(raw) : nodeDragPaths.value;
      nodeDragPaths.value = [];
      if (!dropAllowed(paths, target)) return;
      if (event.ctrlKey) ops.copy(paths, target);
      else ops.move(paths, target);
    },
    onDragEnd: () => {
      nodeDragPaths.value = [];
    },
  };

  const onContextMenu = (event: MouseEvent, path: string | null) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, path });
  };

  // After the item has acted: the row it was about gets the keyboard back,
  // unless the item gave it to something else — the rename field, a dialog.
  const closeMenu = () => {
    const path = menu?.path;
    setMenu(null);
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (path && (active === null || active === document.body)) focusRow(rowElement(path));
    });
  };

  const menuPath = menu?.path ?? null;
  const menuEntry = menuPath ? entryAt(menuPath) : undefined;
  const canOpen = menuEntry !== undefined && menuPath !== null && openTargetFor(menuEntry, menuPath, access).kind !== 'none';

  return (
    <div
      ref={root}
      hidden={!active}
      onFocus={onFocus}
      onKeyDownCapture={onKeyDownCapture}
      style={{ display: active ? 'flex' : 'none', flexDirection: 'column', minHeight: 0, flex: 1 }}
    >
      {ops.error && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} withCloseButton onClose={ops.clearError} m={4}>
          {describeNodeError(ops.error)}
        </Alert>
      )}
      {refused && (
        <Alert color='yellow' variant='light' icon={<IconLock size={16} />} withCloseButton onClose={() => setRefused(null)} m={4}>
          {refused}
        </Alert>
      )}
      <NodeTree
        root={tab.path}
        state={state}
        view={tab.view}
        columns={nodesWorkspace.value.columns}
        onColumns={setNodesColumns}
        sort={tab.sort}
        onSort={(sort) => setNodesTabSort(pane, tab.id, sort)}
        names={names}
        access={access}
        cutPaths={cutPaths}
        onActivate={drill}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        drag={drag}
        renaming={renaming}
        onRename={commitRename}
        onRenameCancel={cancelRename}
      />
      <NodeContextMenu
        state={menu}
        onClose={closeMenu}
        count={menuPath ? selection.length : 0}
        canOpen={canOpen}
        canPaste={clipboard !== null && clipboard.paths.length > 0}
        writable={writable}
        actions={{
          drill: () => menuPath && drill(menuPath),
          open: () => menuPath && open(menuPath),
          cut: () => copyToClipboard('cut'),
          copy: () => copyToClipboard('copy'),
          paste: () => ops.paste(menuPath ?? tab.path),
          rename: askRename,
          remove: askDelete,
          mkdir: () => setDialog({ kind: 'mkdir', parent: menuPath ?? tab.path }),
          properties: () => menuPath && showProperties(menuPath),
          refresh: () => reload(menuPath && tree.expandedState[menuPath] ? menuPath : tab.path),
          // Every node can hold children, a file included, so "here" is the node itself.
          terminal: () => openTerminalTab(`cd ${shq(menuPath ?? tab.path)}`),
        }}
      />
      <NodeDialogs
        dialog={dialog}
        onClose={() => setDialog(null)}
        busy={ops.busy}
        onMkdir={ops.mkdir}
        onDelete={ops.remove}
      />
    </div>
  );
}
