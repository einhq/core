import { Box, Button, Code, Group, Loader, Stack, Text } from '@mantine/core';
import { useDebouncedValue, useMediaQuery } from '@mantine/hooks';
import { useSignals } from '@preact/signals-react/runtime';
import { IconRestore, IconTrashX } from '@tabler/icons-react';
import { type FocusEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { TrashRestoreResult } from '@ein/api';
import { homePath, USER_TRASH_DIR } from '@ein/paths';
import { EmptyState } from '../components/EmptyState/EmptyState.tsx';
import { PageBar } from '../components/EntityDetail/PageBar.tsx';
import { PageLoader } from '../components/Layout/PageLoader.tsx';
import { ROW, separator, toolsColumn } from '../components/Nodes/columns.ts';
import { revealRow } from '../components/Nodes/focus-row.ts';
import { NodeIcon } from '../components/Nodes/NodeIcon.tsx';
import { NodePreview } from '../components/Nodes/NodePreview.tsx';
import { formatWhen } from '../components/Nodes/NodeRow.tsx';
import { NodeTree } from '../components/Nodes/NodeTree.tsx';
import { Dialog, DialogActions } from '../components/Surface/Dialog.tsx';
import { type Identities, useIdentities } from '../hooks/useIdentities.ts';
import { useAccessIds } from '../hooks/useAccessIds.ts';
import { type NodeTreeState, useNodeTree } from '../hooks/useNodeTree.ts';
import { isNotFound } from '../lib/access.ts';
import type { NodeChildEntry } from '../lib/node-entry.ts';
import { baseName, joinPath, parentPath } from '../lib/node-path.ts';
import type { NodeSort } from '../lib/nodes-workspace.ts';
import { shq } from '../lib/shquote.ts';
import { invalidateListing, listNodes, nodesWorkspace, setNodesColumns, setNodesToolsWidth } from '../signals/nodes.ts';
import { notify } from '../signals/notify.ts';
import { execCommand, execScript } from '../signals/shell-client.ts';
import { currentUser } from '../signals/user.ts';

/** The AppShell header. */
const HEADER = 'var(--app-shell-header-height)';
/** How long the row must stay put before the tools load it, as in the explorer's tool pane. */
const SETTLE_MS = 150;

/** How long ago, in words a person would use. */
const ago = (ms: number): string => {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

/** Entries of a batch one `trash restore` call brings back, so a large batch is restored in steps. */
const RESTORE_STEP = 500;

/** What `trash put` wrote on an entry's directory: where its node came from and when it left. */
function entryFacts(entry: NodeChildEntry): { origPath?: string; trashedAt?: number } {
  const attrs = entry.node.attrs as Record<string, unknown>;
  const trashedAt = typeof attrs.trashedAt === 'string' ? Date.parse(attrs.trashedAt) : NaN;
  return {
    ...(typeof attrs.origPath === 'string' ? { origPath: attrs.origPath } : {}),
    ...(Number.isFinite(trashedAt) ? { trashedAt } : {}),
  };
}

/** Whether `entry` is a batch: a directory of entries trashed together (`trash put --batch`). */
const isBatch = (entry: NodeChildEntry | undefined): entry is NodeChildEntry => (entry?.node.attrs as Record<string, unknown> | undefined)?.batch === true;

/** What a batch is called in the trash: its label, or what it is when it has none. */
const batchLabel = (entry: NodeChildEntry): string => {
  const label = (entry.node.attrs as Record<string, unknown>).label;
  return typeof label === 'string' && label !== '' ? label : 'Removed together';
};

/** `n` items, in words. */
const items = (n: number): string => n === 1 ? '1 item' : `${n} items`;

/** How many trashed nodes a row of the trash stands for: a batch's entries, or the one. */
const sizeOf = (entry: NodeChildEntry | undefined): number => isBatch(entry) ? entry.childCount : 1;

/**
 * The directory `trash restore` and `trash empty` act on for a row at `path` in the trash at
 * `trashPath`: the entry it is in — inside a batch, the batch's entry — or a batch's own row.
 * Its path below `trashPath` is the id those commands take (`<batch>/<entry>` for a batch's).
 */
function entryDirOf(trashPath: string, path: string, entryAt: NodeTreeState['entryAt']): string {
  const [top, inner] = path.slice(trashPath.length + 1).split('/');
  const topPath = joinPath(trashPath, top);
  return inner !== undefined && isBatch(entryAt(topPath)) ? joinPath(topPath, inner) : topPath;
}

/** The administrator's retention setting, as the shell has it; the purger's own default when unset. */
function useRetentionDays(): number {
  const [days, setDays] = useState(30);
  useEffect(() => {
    execScript('echo "${CFG_TRASH_RETENTION_DAYS:-30}"')
      .then((out) => {
        const value = Number(out.trim());
        if (Number.isFinite(value) && value > 0) setDays(value);
      })
      .catch(() => {});
  }, []);
  return days;
}

/**
 * The reader's trash, as the directory it is (`~/.trash`, one directory per
 * entry holding the trashed node), in the explorer's tree, with a tool pane
 * beside it that shows what is selected and restores it or deletes it for
 * good. A batch — files discarded together — is a directory of such entries:
 * its row reads as its label and how many it holds, and its entries are its
 * children. Everything stays restorable until the trash-purger removes it.
 */
export default function TrashPage() {
  useSignals();
  const user = currentUser.value;
  if (!user) return <PageLoader />;
  return <Trash trashPath={joinPath(homePath(user.username), USER_TRASH_DIR)} />;
}

function Trash({ trashPath }: { trashPath: string }) {
  useSignals();
  const [sort, setSort] = useState<NodeSort>({ key: 'modified', dir: 'desc' });
  const state = useNodeTree(trashPath, sort);
  const { tree, data, loading, error, entryAt } = state;
  const { names } = useIdentities();
  const access = useAccessIds();
  const retention = useRetentionDays();
  const workspace = nodesWorkspace.value;
  const phone = useMediaQuery('(max-width: 48em)');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string[] | 'all' | null>(null);
  const container = useRef<HTMLDivElement>(null);

  // A reader who never deleted anything has no trash directory yet.
  const empty = !loading && (error ? isNotFound(error) : data.length === 0);
  const entryIds = data.map((node) => baseName(node.value));
  const idOfDir = (dir: string) => dir.slice(trashPath.length + 1);
  const entryIdOf = (path: string) => idOfDir(entryDirOf(trashPath, path, entryAt));
  const selection = tree.selectedState;
  const selectedIds = [...new Set(selection.map(entryIdOf))];
  /** How many trashed nodes the entries `ids` hold: a batch counts what is in it. */
  const sizeOfIds = (ids: string[]) => ids.reduce((sum, id) => sum + (id.includes('/') ? 1 : sizeOf(entryAt(joinPath(trashPath, id)))), 0);
  const total = sizeOfIds(entryIds);

  // The row the tools are about: the last one to take the keyboard, which a click does too.
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (selection.length === 1) setCurrent(selection[0]);
    else if (selection.length === 0) setCurrent(null);
  }, [selection]);

  // The arrows move the selection, as in the explorer; Shift and Ctrl leave it to the tree.
  const navKeys = useRef({ extend: false, scrollLeft: 0 });
  const onKeyDownCapture = (event: KeyboardEvent) => {
    const area = container.current?.querySelector<HTMLElement>('[data-nodes-area]');
    navKeys.current = { extend: event.shiftKey || event.ctrlKey || event.metaKey, scrollLeft: area?.scrollLeft ?? 0 };
  };
  const onFocus = (event: FocusEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[role=treeitem]');
    const path = row?.dataset.value;
    if (!row || !path) return;
    setCurrent(path);
    if (!row.hasAttribute('data-focus-ring')) return;
    const area = container.current?.querySelector<HTMLElement>('[data-nodes-area]');
    if (area) area.scrollLeft = navKeys.current.scrollLeft;
    revealRow(row);
    if (!navKeys.current.extend) {
      tree.select(path);
      tree.setSelectedState([path]);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const focused = (event.target as HTMLElement).closest<HTMLElement>('[role=treeitem]')?.dataset.value;
    if (event.key === 'Enter' && focused) tree.toggleExpanded(focused);
    else if (event.key === 'Delete' && selectedIds.length > 0) setConfirm(selectedIds);
    else if (event.key === 'F5') invalidateListing(trashPath);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  // An entry's directory is named by its id; it reads as where its node came from, in the trash
  // or in a batch. A batch's reads as its label and how many it holds.
  const labelOf = useCallback(
    (entry: NodeChildEntry, path: string) => {
      const parent = parentPath(path);
      if (parent === trashPath) return isBatch(entry) ? `${batchLabel(entry)} · ${items(entry.childCount)}` : entryFacts(entry).origPath;
      return parentPath(parent) === trashPath && isBatch(entryAt(parent)) ? entryFacts(entry).origPath : undefined;
    },
    [trashPath, entryAt],
  );

  const done = () => {
    setBusy(false);
    setConfirm(null);
    tree.clearSelected();
  };

  /** The listings `ids` change: the trash's, and that of each batch one of them is or is in. */
  const touched = (ids: string[]) => [trashPath, ...new Set(ids.map((id) => joinPath(trashPath, id.split('/')[0])))];

  // A batch comes back RESTORE_STEP entries to a call, until none remain; the rest in one call.
  const restore = async (ids: string[]) => {
    setBusy(true);
    const restored: TrashRestoreResult['restored'] = [];
    try {
      const batches = ids.filter((id) => !id.includes('/') && isBatch(entryAt(joinPath(trashPath, id))));
      const single = ids.filter((id) => !batches.includes(id));
      if (single.length > 0) restored.push(...(await execCommand<TrashRestoreResult>(`trash restore ${single.map(shq).join(' ')}`)).restored);
      for (const batch of batches) {
        for (;;) {
          const step = await execCommand<TrashRestoreResult>(`trash restore ${shq(batch)} --limit ${RESTORE_STEP}`);
          restored.push(...step.restored);
          if (!step.remaining || step.restored.length === 0) break;
        }
      }
      notify({ message: restored.length === 1 ? `Restored to ${restored[0].path}` : `${restored.length} restored`, color: 'green' });
    } catch (err) {
      notify({ message: err instanceof Error ? err.message : String(err), color: 'red' });
    } finally {
      invalidateListing(...touched(ids), ...new Set(restored.map((each) => parentPath(each.path))));
      done();
    }
  };

  const remove = async (ids: string[] | 'all') => {
    setBusy(true);
    try {
      await execCommand(`trash empty${ids === 'all' ? '' : ` ${ids.map(shq).join(' ')}`}`);
    } catch (err) {
      notify({ message: err instanceof Error ? err.message : String(err), color: 'red' });
    } finally {
      invalidateListing(...touched(ids === 'all' ? entryIds : ids));
      done();
    }
  };

  const startToolsResize = (event: ReactMouseEvent) => {
    event.preventDefault();
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    const move = (moveEvent: MouseEvent) => setNodesToolsWidth(box.right - moveEvent.clientX);
    const stop = () => {
      globalThis.removeEventListener('mousemove', move);
      globalThis.removeEventListener('mouseup', stop);
    };
    globalThis.addEventListener('mousemove', move);
    globalThis.addEventListener('mouseup', stop);
  };

  const confirmCount = confirm === 'all' ? total : confirm ? sizeOfIds(confirm) : 0;

  const toolPane = (
    <TrashTools
      trashPath={trashPath}
      current={current}
      selectedIds={selectedIds}
      state={state}
      names={names}
      busy={busy}
      retention={retention}
      count={total}
      onRestore={restore}
      onDelete={setConfirm}
    />
  );

  return (
    <Box style={{ height: `calc(100dvh - ${HEADER})`, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--mrx-surface-base)' }}>
      <PageBar
        title='Trash'
        pattern='system'
        controls={!empty && entryIds.length > 0 && (
          <>
            <Button size='compact-sm' variant='light' leftSection={<IconRestore size={16} />} disabled={busy} onClick={() => restore(entryIds)}>
              Restore all
            </Button>
            <Button size='compact-sm' variant='light' color='red' leftSection={<IconTrashX size={16} />} disabled={busy} onClick={() => setConfirm('all')}>
              Empty trash
            </Button>
          </>
        )}
      />
      {empty
        ? <EmptyState title='The trash is empty'>What you delete waits here for {retention} days, in case you want it back.</EmptyState>
        : (
          <div ref={container} style={{ ...ROW, flex: 1, minHeight: 0, flexDirection: phone ? 'column' : 'row' }}>
            <div
              className='mrx-node-pane'
              data-focused
              onFocus={onFocus}
              onKeyDownCapture={onKeyDownCapture}
              style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}
            >
              <NodeTree
                root={trashPath}
                state={state}
                view='details'
                columns={workspace.columns}
                onColumns={setNodesColumns}
                sort={sort}
                onSort={setSort}
                names={names}
                access={access}
                onActivate={(path) => tree.toggleExpanded(path)}
                onContextMenu={() => {}}
                onKeyDown={onKeyDown}
                labelOf={labelOf}
              />
            </div>
            {phone ? <div style={{ flex: 1, minHeight: 0, display: 'flex', borderTop: '1px solid var(--mrx-hairline)' }}>{toolPane}</div> : (
              <>
                <div onMouseDown={startToolsResize} role='separator' aria-orientation='vertical' aria-label='Resize tools' style={separator(true)} />
                <div style={toolsColumn(workspace.tools.width)}>{toolPane}</div>
              </>
            )}
          </div>
        )}

      <Dialog opened={confirm !== null} onClose={() => setConfirm(null)} title='Delete for good?' icon='trash' pattern='danger' size='sm' floating>
        <Text size='sm'>
          {confirm === 'all' ? 'Everything in the trash' : confirmCount === 1 ? 'This item' : `These ${confirmCount} items`}
          {confirmCount === 1 ? ' and everything derived from it is' : ' and everything derived from them are'} removed for good. This cannot be undone.
        </Text>
        <DialogActions>
          <Button variant='default' onClick={() => setConfirm(null)}>Cancel</Button>
          <Button color='red' loading={busy} onClick={() => confirm && remove(confirm)}>{confirm === 'all' ? 'Empty trash' : 'Delete for good'}</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

type TrashToolsProps = {
  trashPath: string;
  /** The row the tools are about, or `null` with nothing selected. */
  current: string | null;
  /** The entries the selection is in: what Restore and Delete act on. */
  selectedIds: string[];
  state: NodeTreeState;
  names: Identities;
  busy: boolean;
  retention: number;
  /** Trashed nodes in the trash, a batch's each counted. */
  count: number;
  onRestore: (ids: string[]) => void;
  onDelete: (ids: string[]) => void;
};

/**
 * The trash's tool pane: the selected entry — where it came from, when it
 * left — with Restore and Delete, and its node as the explorer previews it.
 * An entry's own row shows the node it holds; a row deeper inside shows that
 * row, and the buttons still act on the whole entry, since only an entry can
 * be put back. A batch's own row shows its label, how many it holds and when
 * it left; its buttons act on all of it.
 */
function TrashTools({ trashPath, current, selectedIds, state, names, busy, retention, count, onRestore, onDelete }: TrashToolsProps) {
  const [settled] = useDebouncedValue(current, SETTLE_MS);
  const entryDir = settled ? entryDirOf(trashPath, settled, state.entryAt) : null;
  const dirEntry = entryDir ? state.entryAt(entryDir) : undefined;
  const facts = dirEntry ? entryFacts(dirEntry) : {};
  const batch = isBatch(dirEntry) ? dirEntry : undefined;

  // What an entry holds is listed only once its row is expanded; the tools list it themselves.
  const [held, setHeld] = useState<{ dir: string; entry: NodeChildEntry | undefined } | null>(null);
  useEffect(() => {
    if (!entryDir || batch) return;
    let live = true;
    listNodes(entryDir)
      .then(([entry]) => live && setHeld({ dir: entryDir, entry }))
      .catch(() => live && setHeld({ dir: entryDir, entry: undefined }));
    return () => {
      live = false;
    };
  }, [entryDir, dirEntry, batch]);

  const onEntryRow = settled === entryDir;
  const heldEntry = held?.dir === entryDir ? held.entry : undefined;
  const shownPath = onEntryRow ? (heldEntry ? joinPath(entryDir!, heldEntry.name) : null) : settled;
  const shown = onEntryRow ? heldEntry : settled ? state.entryAt(settled) : undefined;
  const ids = selectedIds;
  const several = ids.length > 1;

  if (!settled || !entryDir) {
    return (
      <Box style={{ flex: 1, padding: 12, background: 'var(--mrx-surface-base)' }}>
        <Text size='sm' c='dimmed'>
          {count === 1 ? 'One item' : `${count} items`}, each restorable for {retention}{' '}
          days after it was deleted. Select one to see it here, and to restore it or delete it for good.
        </Text>
      </Box>
    );
  }

  const buttons = (
    <Group gap='xs'>
      <Button size='compact-sm' variant='light' leftSection={<IconRestore size={16} />} loading={busy} onClick={() => onRestore(ids)} disabled={ids.length === 0}>
        {several ? `Restore ${ids.length}` : 'Restore'}
      </Button>
      <Button
        size='compact-sm'
        variant='subtle'
        color='red'
        leftSection={<IconTrashX size={16} />}
        disabled={busy || ids.length === 0}
        onClick={() => onDelete(ids)}
      >
        {several ? `Delete ${ids.length} for good` : 'Delete for good'}
      </Button>
    </Group>
  );

  if (batch) {
    return (
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', padding: 8, background: 'var(--mrx-surface-base)' }}>
        <Stack gap='sm'>
          <Group gap={6} wrap='nowrap'>
            <NodeIcon entry={batch} path={entryDir} size={20} />
            <Text size='sm' fw={600} truncate style={{ flex: 1, minWidth: 0 }} title={batchLabel(batch)}>{batchLabel(batch)}</Text>
          </Group>
          <Stack gap={2}>
            <Text size='xs' c='dimmed'>{items(batch.childCount)}, removed together; restoring puts back all of them.</Text>
            {facts.trashedAt !== undefined && <Text size='xs' c='dimmed'>Deleted {ago(facts.trashedAt)}, {formatWhen(facts.trashedAt)}</Text>}
            {several && <Text size='xs' c='dimmed'>{ids.length} selected; showing the current row.</Text>}
          </Stack>
          {buttons}
        </Stack>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', padding: 8, background: 'var(--mrx-surface-base)' }}>
      <Stack gap='sm'>
        <Group gap={6} wrap='nowrap'>
          {shown && shownPath && <NodeIcon entry={shown} path={shownPath} size={20} />}
          <Text size='sm' fw={600} ff='monospace' truncate style={{ flex: 1, minWidth: 0 }} title={shownPath ?? undefined}>
            {shown?.name ?? baseName(facts.origPath ?? '')}
          </Text>
        </Group>
        <Stack gap={2}>
          {facts.origPath && (
            <Text size='xs' c='dimmed'>
              From <Code>{facts.origPath}</Code>
            </Text>
          )}
          {facts.trashedAt !== undefined && <Text size='xs' c='dimmed'>Deleted {ago(facts.trashedAt)}, {formatWhen(facts.trashedAt)}</Text>}
          {!onEntryRow && <Text size='xs' c='dimmed'>Inside what was deleted; restoring puts back all of it.</Text>}
          {several && <Text size='xs' c='dimmed'>{ids.length} selected; showing the current row.</Text>}
        </Stack>
        {buttons}
        {shownPath && shown ? <NodePreview path={shownPath} entry={shown} stat={null} names={names} /> : <Loader size='sm' />}
      </Stack>
    </div>
  );
}
