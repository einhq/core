import { Alert, Box, Loader, Text, Tree, UnstyledButton } from '@mantine/core';
import { IconAlertTriangle, IconChevronDown, IconChevronUp, IconLock } from '@tabler/icons-react';
import { type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, useRef } from 'react';
import type { NodeTreeState } from '../../hooks/useNodeTree.ts';
import type { NodeChildEntry } from '../../lib/node-entry.ts';
import { type AccessIds, describeNodeError, isAccessDenied } from '../../lib/access.ts';
import type { NodeSort, SortKey, ViewMode } from '../../lib/nodes-workspace.ts';
import { DirectoryWatcher } from './DirectoryWatcher.tsx';
import type { Identities } from '../../hooks/useIdentities.ts';
import { columnsMinWidth, columnTemplate, DEFAULT_COLUMN_WIDTHS, DETAIL_COLUMN_LABELS, withColumnWidth } from '../../lib/node-columns.ts';
import { DETAIL_COLUMNS, NodeRow, type RowDragHandlers } from './NodeRow.tsx';

type NodeTreeProps = {
  root: string;
  state: NodeTreeState;
  view: ViewMode;
  sort: NodeSort;
  /** The details view's column widths, and where a drag of a column's edge sends the new ones. */
  columns: number[];
  onColumns: (columns: number[]) => void;
  /** A click on a sortable column's name: that column, or the other way round when it is the one sorted by. */
  onSort: (sort: NodeSort) => void;
  names: Identities;
  /** The reader, for which rows can be opened; `null` while unknown. */
  access: AccessIds | null;
  /** Paths waiting in a cut clipboard, drawn dimmed. */
  cutPaths?: Set<string>;
  onActivate: (path: string) => void;
  /** `path` is `null` for the empty area below the rows. */
  onContextMenu: (event: MouseEvent, path: string | null) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  /** Without it, rows cannot be dragged and nothing can be dropped on them. */
  drag?: RowDragHandlers;
  /** The row whose name is being edited in place. */
  renaming?: string | null;
  onRename?: (path: string, name: string) => void;
  onRenameCancel?: (path: string) => void;
  /** What a row shows in place of its name, when it says something; the name otherwise. */
  labelOf?: (entry: NodeChildEntry, path: string) => string | undefined;
};

/** The key each column sorts by; mode, owner and group are not sorted on. */
const SORT_OF: Partial<Record<(typeof DETAIL_COLUMN_LABELS)[number], SortKey>> = { Name: 'name', Type: 'type', Size: 'size', Modified: 'modified' };

/** The grab area on a column name's right edge, straddling the gap to the next. */
const RESIZER: CSSProperties = { position: 'absolute', top: -4, bottom: -4, right: -9, width: 7, cursor: 'col-resize', zIndex: 1 };

/**
 * The Mantine tree with the explorer's rows, headed by columns in the details
 * view, watched per open directory, and with the space around the rows acting
 * for the root: a drop there lands in the tab's directory, a right click there
 * is about the directory rather than a node in it, and a plain click there
 * clears the selection, as in any file manager.
 */
export function NodeTree(
  {
    root,
    state,
    view,
    columns,
    onColumns,
    sort,
    onSort,
    names,
    access,
    cutPaths,
    onActivate,
    onContextMenu,
    onKeyDown,
    drag,
    renaming,
    onRename,
    onRenameCancel,
    labelOf,
  }: NodeTreeProps,
) {
  const { data, tree, loading, error, reload, openDirs } = state;

  const background = {
    onDragOver: (event: DragEvent) => {
      if (event.target !== event.currentTarget) return;
      drag?.onDragOver(event, root);
    },
    onDrop: (event: DragEvent) => {
      if (event.target !== event.currentTarget) return;
      drag?.onDrop(event, root);
    },
    onContextMenu: (event: MouseEvent) => {
      if (event.target !== event.currentTarget) return;
      onContextMenu(event, null);
    },
  };

  // A column's edge is dragged on the listing's own style, so no row renders
  // until the drop, when the widths are stored and every tab takes them.
  const listing = useRef<HTMLDivElement>(null);
  const columnVars = (widths: readonly number[]) => ({ '--mrx-detail-columns': columnTemplate(widths), minWidth: `${columnsMinWidth(widths)}px` });
  const startColumnResize = (event: MouseEvent, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    // From the width drawn, not the one stored: the name column also takes
    // whatever the pane has spare, and a drag should move the edge at once.
    const startWidth = (event.currentTarget as HTMLElement).parentElement?.getBoundingClientRect().width ?? columns[index];
    let next = columns;
    const move = (moveEvent: globalThis.MouseEvent) => {
      next = withColumnWidth(columns, index, startWidth + moveEvent.clientX - startX);
      const style = listing.current?.style;
      if (!style) return;
      const vars = columnVars(next);
      style.setProperty('--mrx-detail-columns', vars['--mrx-detail-columns']);
      style.minWidth = vars.minWidth;
    };
    const stop = () => {
      globalThis.removeEventListener('mousemove', move);
      globalThis.removeEventListener('mouseup', stop);
      document.body.style.cursor = '';
      if (next !== columns) onColumns(next);
    };
    document.body.style.cursor = 'col-resize';
    globalThis.addEventListener('mousemove', move);
    globalThis.addEventListener('mouseup', stop);
  };

  // On the area as a whole rather than the background's own box, so a click
  // between tiles, which lands on the tree's list, clears as well.
  const clearOnBackground = (event: MouseEvent) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey) return;
    if ((event.target as HTMLElement).closest('[role=treeitem], [data-nodes-header]')) return;
    if (tree.selectedState.length > 0) tree.clearSelected();
  };

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      {openDirs.map((dir) => <DirectoryWatcher key={dir} path={dir} onChange={reload} />)}

      <div
        data-nodes-area
        style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
        onKeyDown={onKeyDown}
        onClick={clearOnBackground}
        {...background}
      >
        {
          /* The columns need more width than half a screen gives; the whole
            listing scrolls sideways rather than the columns squeezing, and
            the header scrolls with it so a column stays under its name. */
        }
        {/* Rows run edge to edge, so the selection does; tiles keep a little air. */}
        <div
          ref={listing}
          style={{ ...(view === 'details' ? columnVars(columns) : {}), minHeight: '100%', padding: view === 'icons' ? 4 : 0 } as CSSProperties}
          {...background}
        >
          {view === 'details' && (
            <div
              data-nodes-header
              style={{
                display: 'grid',
                gridTemplateColumns: DETAIL_COLUMNS,
                columnGap: 12,
                padding: '4px 6px',
                borderBottom: '1px solid var(--mantine-color-default-border)',
                position: 'sticky',
                top: 0,
                background: 'var(--mrx-pane-bg)',
                zIndex: 1,
              }}
            >
              {DETAIL_COLUMN_LABELS.map((label, index) => {
                const key = SORT_OF[label];
                const text = <Text size='xs' c='dimmed' fw={600} truncate>{label}</Text>;
                const sorted = key !== undefined && sort.key === key;
                const Arrow = sort.dir === 'asc' ? IconChevronUp : IconChevronDown;
                return (
                  <div key={label} style={{ position: 'relative', minWidth: 0, display: 'flex' }}>
                    {key
                      ? (
                        <UnstyledButton
                          onClick={() => onSort({ key, dir: sorted ? (sort.dir === 'asc' ? 'desc' : 'asc') : 'asc' })}
                          title={`Sort by ${label.toLowerCase()}`}
                          aria-sort={sorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                          style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}
                        >
                          {text}
                          {sorted && <Arrow size={12} style={{ flexShrink: 0, color: 'var(--mantine-color-dimmed)' }} />}
                        </UnstyledButton>
                      )
                      : text}
                    {index < DETAIL_COLUMN_LABELS.length - 1 && (
                      <div
                        role='separator'
                        aria-orientation='vertical'
                        aria-label={`Resize ${label.toLowerCase()}`}
                        className='mrx-column-resizer'
                        title='Drag to resize; double-click for the default width'
                        style={RESIZER}
                        onMouseDown={(event) => startColumnResize(event, index)}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={() => onColumns(withColumnWidth(columns, index, DEFAULT_COLUMN_WIDTHS[index]))}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {error && (isAccessDenied(error)
            ? (
              <Alert color='yellow' variant='light' icon={<IconLock size={16} />} m='xs'>
                You do not have permission to open {root}.
              </Alert>
            )
            : <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} m='xs'>{describeNodeError(error)}</Alert>)}
          {loading && !error && <Loader size='sm' m='md' />}
          {!loading && !error && data.length === 0 && <Text size='sm' c='dimmed' p='md'>Empty</Text>}
          <Tree
            className='mrx-node-tree'
            data={data}
            tree={tree}
            levelOffset={0}
            expandOnClick={false}
            selectOnClick={false}
            styles={view === 'icons' ? { root: { display: 'flex', flexWrap: 'wrap', gap: 4, alignContent: 'flex-start' }, subtree: { display: 'none' } } : undefined}
            renderNode={(payload) => (
              <NodeRow
                payload={payload}
                view={view}
                names={names}
                access={access}
                cut={cutPaths?.has(payload.node.value) ?? false}
                onActivate={onActivate}
                onContextMenu={onContextMenu}
                drag={drag}
                renaming={renaming === payload.node.value}
                onRename={onRename}
                onRenameCancel={onRenameCancel}
                labelOf={labelOf}
              />
            )}
          />
        </div>
      </div>
    </Box>
  );
}
