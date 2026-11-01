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
import type { NodeSort, ViewMode } from '../../lib/nodes-workspace.ts';
import { openMediaAt } from '../../signals/album.ts';
import { openCodeEditor } from '../../signals/code-editor.ts';
import { openTerminalTab } from '../../signals/terminal.ts';
import { invalidateListing, nodeClipboard, nodeDragPaths, type NodesCurrent } from '../../signals/nodes.ts';
import { type ContextMenuState, NodeContextMenu } from './NodeContextMenu.tsx';
import { type NodeDialog, NodeDialogs } from './NodeDialogs.tsx';
import { setDragChip } from '../../lib/drag-chip.ts';
import { focusRow, revealRow } from './focus-row.ts';
import type { RowDragHandlers } from './NodeRow.tsx';
import { NodeTree } from './NodeTree.tsx';

const DRAG_MIME = 'application/x-ein-nodes';

type NodeListingProps = {
  /** The directory listed. */
  path: string;
  /** Where going into a row, or up a level, takes the listing. */
  onNavigate: (path: string) => void;
  view: ViewMode;
  sort: NodeSort;
  onSort: (sort: NodeSort) => void;
  /** The details view's column widths, and where a drag of a column's edge sends the new ones. */
  columns: number[];
  onColumns: (columns: number[]) => void;
  /** Whether names starting with a dot are listed, and where Ctrl+H sends the other answer. */
  showHidden: boolean;
  onShowHidden: (showHidden: boolean) => void;
  names: Identities;
  /** Whether it is shown; a hidden one keeps its expanded rows and says nothing of its current row. Shown when left out. */
  active?: boolean;
  /** The row a side panel is about, whenever it changes: the last to take the keyboard; `null` for the directory itself. */
  onCurrent?: (current: NodesCurrent | null) => void;
  /** The selected rows' paths, whenever they change. */
  onSelection?: (paths: string[]) => void;
  /** Delete and the context menu's Delete, given the selected paths, instead of the listing's own `rm` with its confirmation. */
  onDelete?: (paths: string[]) => void;
  /** Properties, from Alt+Enter or the context menu. */
  onProperties: (path: string) => void;
  /** A row to select and give the keyboard once the listing has it, and the call that says it has. */
  reveal?: string | null;
  onRevealed?: () => void;
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
 * One directory's tree and everything that acts on it: the keys, the context
 * menu, drag and drop, rename in place and the dialogs. Where it is, how it
 * is viewed and sorted, and which row is current are its caller's — the Nodes
 * page's workspace (`NodeTabView`), or a `NodeBrowser`'s own state.
 */
export function NodeListing(
  {
    path,
    onNavigate,
    view,
    sort,
    onSort,
    columns,
    onColumns,
    showHidden,
    onShowHidden,
    names,
    active = true,
    onCurrent,
    onSelection,
    onProperties,
    onDelete,
    reveal,
    onRevealed,
  }: NodeListingProps,
) {
  useShortcutHelp('Nodes', NODE_SHORTCUTS);
  useSignals();
  const state = useNodeTree(path, sort, showHidden);
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

  // The callers' handlers are read when they fire, not watched: one made afresh on every
  // render would otherwise re-run the effects below each time, and a caller that keeps the
  // current row in its state would never settle.
  const handlers = useRef({ onNavigate, onCurrent, onSelection });
  handlers.current = { onNavigate, onCurrent, onSelection };
  const navigate = useCallback((to: string) => handlers.current.onNavigate(to), []);

  // Going into a row the reader may not list would only swap the listing for
  // an error; the row stays, and the reason is said above it.
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => setRefused(null), [path]);
  const drill = useCallback((to: string) => {
    const entry = entryAt(to);
    if (entry && !canList(entry.node.props, access)) setRefused(`You do not have permission to open ${entry.name}.`);
    else navigate(to);
  }, [entryAt, access, navigate]);

  // The icons view has no in-place expansion: tiles wrap, and a subtree inside
  // a tile would break the flow.
  useEffect(() => {
    if (view === 'icons') tree.setExpandedState({});
  }, [view]);

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

  // Rows that have gone — moved or deleted, from here or elsewhere — leave the
  // selection, where a delete, a cut or a caller's action would still take them.
  // Only a listing that is here and lacks the row says so; one being read again says nothing.
  useEffect(() => {
    const gone = (at: string) => {
      const listing = entriesOf(parentPath(at));
      return listing !== undefined && !listing.some((entry) => entry.name === baseName(at));
    };
    const kept = tree.selectedState.filter((at) => !gone(at));
    if (kept.length !== tree.selectedState.length) tree.setSelectedState(kept);
  }, [data]);

  // The row the tool pane is about: the last one to take the keyboard, which a
  // click does too, so arrowing through the tree previews as it goes. With the
  // selection cleared, it is the tab's directory again.
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => setCurrent(null), [path]);
  useEffect(() => {
    if (selection.length === 1) setCurrent(selection[0]);
    else if (selection.length === 0) setCurrent(null);
    handlers.current.onSelection?.(selection);
  }, [selection]);
  // The arrow keys move the selection, not just the keyboard: Mantine's tree
  // only moves focus, marking the row it moved to with `data-focus-ring`, which
  // a click never sets. Shift extends the selection (the tree does that) and
  // Ctrl moves without selecting, so rows can still be picked one by one.
  const navKeys = useRef({ shift: false, ctrl: false, scrollLeft: 0 });
  const onKeyDownCapture = (event: KeyboardEvent) => {
    const area = root.current?.querySelector<HTMLElement>('[data-nodes-area]');
    navKeys.current = { shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey, scrollLeft: area?.scrollLeft ?? 0 };
    if (view === 'icons') moveInGrid(event);
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
    handlers.current.onCurrent?.(current && currentEntry ? { path: current, entry: currentEntry, open: openCurrent, selected: selection.length } : null);
  }, [active, current, currentEntry, openCurrent, selection.length]);

  const showProperties = onProperties;

  const copyToClipboard = useCallback((mode: 'copy' | 'cut') => {
    if (selection.length > 0) nodeClipboard.value = { mode, paths: [...selection] };
  }, [selection]);

  const askDelete = useCallback(() => {
    const entries = selectedEntries();
    if (entries.length === 0) return;
    if (onDelete) return onDelete(entries.map((item) => item.path));
    setDialog({ kind: 'delete', paths: entries.map((item) => item.path), nonEmpty: entries.filter((item) => item.entry.childCount > 0).length });
  }, [selectedEntries, onDelete]);

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
  }, [path]);

  // A row asked to be shown (`reveal`); select it once the listing has the row.
  useEffect(() => {
    if (!reveal) return;
    const row = rowElement(reveal);
    if (!row) return;
    onRevealed?.();
    tree.select(reveal);
    tree.setSelectedState([reveal]);
    focusRow(row);
  }, [reveal, data]);

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
      navigate(parentPath(path));
    } else if (event.key === 'F2') {
      askRename();
    } else if (event.key === 'Delete') {
      if (writable) askDelete();
    } else if (event.key === 'F5') {
      invalidateListing(path);
    } else if (ctrl && key === 'h') {
      onShowHidden(!showHidden);
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
      if (writable) ops.paste(path);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const drag: RowDragHandlers = {
    onDragStart: (event: DragEvent, dragged: string) => {
      const paths = selection.includes(dragged) ? [...selection] : [dragged];
      nodeDragPaths.value = paths;
      event.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths));
      event.dataTransfer.setData('text/plain', paths.join('\n'));
      event.dataTransfer.effectAllowed = 'copyMove';
      // The dragged row's name, and how many more of the selection come with it.
      setDragChip(event, event.currentTarget as HTMLElement, baseName(dragged), paths.length - 1);
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

  const onContextMenu = (event: MouseEvent, at: string | null) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, path: at });
  };

  // After the item has acted: the row it was about gets the keyboard back,
  // unless the item gave it to something else — the rename field, a dialog.
  const closeMenu = () => {
    const at = menu?.path;
    setMenu(null);
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (at && (focused === null || focused === document.body)) focusRow(rowElement(at));
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
        root={path}
        state={state}
        view={view}
        columns={columns}
        onColumns={onColumns}
        sort={sort}
        onSort={onSort}
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
          paste: () => ops.paste(menuPath ?? path),
          rename: askRename,
          remove: askDelete,
          mkdir: () => setDialog({ kind: 'mkdir', parent: menuPath ?? path }),
          properties: () => menuPath && showProperties(menuPath),
          refresh: () => reload(menuPath && tree.expandedState[menuPath] ? menuPath : path),
          // Every node can hold children, a file included, so "here" is the node itself.
          terminal: () => openTerminalTab(`cd ${shq(menuPath ?? path)}`),
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
