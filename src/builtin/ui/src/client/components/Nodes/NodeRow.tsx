import { ActionIcon, Loader, type RenderTreeNodePayload, Text } from '@mantine/core';
import { IconChevronRight, IconLock } from '@tabler/icons-react';
import { type DragEvent, type MouseEvent, useState } from 'react';
import type { Identities } from '../../hooks/useIdentities.ts';
import { type AccessIds, canList, describeNodeError } from '../../lib/access.ts';
import { formatBytes } from '../../lib/format.ts';
import { type NodeChildEntry, toMillis } from '../../lib/node-entry.ts';
import { nodeTypeLabel } from '../../lib/node-kind.ts';
import { modeString } from '../../lib/node-mode.ts';
import { isContainer, type NodeTreeProps } from '../../lib/node-sort.ts';
import type { ViewMode } from '../../lib/nodes-workspace.ts';
import { focusRow } from './focus-row.ts';
import { NodeIcon } from './NodeIcon.tsx';
import { NodeNameInput } from './NodeNameInput.tsx';

/** The details view's columns, set on the listing by `NodeTree` from the widths a person dragged (`lib/node-columns.ts`). */
export const DETAIL_COLUMNS = 'var(--mrx-detail-columns)';
const INDENT = 20;
const ICON_SIZE = 18;
const TILE_ICON = 56;

const pad = (n: number) => String(n).padStart(2, '0');

/** `2024-06-10 14:02:37`; a date alone would hide which of today's uploads came first, and an import writes several a minute. */
export function formatWhen(ms?: number): string {
  if (ms === undefined) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export type RowDragHandlers = {
  onDragStart: (event: DragEvent, path: string) => void;
  /** Return `true` when a drop here is allowed; the row then lights up. */
  onDragOver: (event: DragEvent, path: string) => boolean;
  onDrop: (event: DragEvent, path: string) => void;
  onDragEnd: () => void;
};

type NodeRowProps = {
  payload: RenderTreeNodePayload;
  view: ViewMode;
  names: Identities;
  access: AccessIds | null;
  cut: boolean;
  onActivate: (path: string) => void;
  onContextMenu: (event: MouseEvent, path: string) => void;
  drag?: RowDragHandlers;
  /** The name is being edited in place. */
  renaming: boolean;
  onRename?: (path: string, name: string) => void;
  onRenameCancel?: (path: string) => void;
  /** What the row shows in place of its name, when it says something. */
  labelOf?: (entry: NodeChildEntry, path: string) => string | undefined;
};

/**
 * One node in a pane, drawn for the tab's view.
 *
 * Selection is done here rather than by the tree's own click handling, whose
 * `select` appends in multiple mode: a plain click must replace the selection,
 * a Ctrl-click toggle it, and only a Shift-click — delegated to the tree —
 * extend it from the anchor.
 *
 * Every text in a row is monospace: names that differ by a digit, sizes and
 * dates line up down the listing, and a path reads the way the shell prints it.
 */
export function NodeRow({ payload, view, names, access, cut, onActivate, onContextMenu, drag, renaming, onRename, onRenameCancel, labelOf }: NodeRowProps) {
  const { node, level, expanded, hasChildren, selected, isLoading, loadError, tree, elementProps } = payload;
  const { entry, path } = node.nodeProps as NodeTreeProps;
  const [over, setOver] = useState(false);
  const label = labelOf?.(entry, path) ?? entry.name;

  const handleClick = (event: MouseEvent) => {
    if (event.shiftKey) {
      elementProps.onClick(event);
      return;
    }
    if (event.ctrlKey || event.metaKey) tree.toggleSelected(node.value);
    else {
      tree.select(node.value);
      tree.setSelectedState([node.value]);
    }
    focusRow((event.currentTarget as HTMLElement).closest<HTMLElement>('[role=treeitem]'));
  };

  const handleContextMenu = (event: MouseEvent) => {
    if (!selected) {
      tree.select(node.value);
      tree.setSelectedState([node.value]);
    }
    onContextMenu(event, path);
  };

  const toggle = (event: MouseEvent) => {
    event.stopPropagation();
    tree.toggleExpanded(node.value);
  };

  const dragProps = drag
    ? {
      // Off while renaming, so dragging across the name selects text instead.
      draggable: !renaming,
      onDragStart: (event: DragEvent) => drag.onDragStart(event, path),
      onDragEnd: drag.onDragEnd,
      onDragOver: (event: DragEvent) => setOver(drag.onDragOver(event, path)),
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        setOver(false);
        drag.onDrop(event, path);
      },
    }
    : {};

  const common = {
    className: elementProps.className,
    'data-selected': elementProps['data-selected'],
    'data-value': elementProps['data-value'],
    'data-drag-over': over ? 'inside' : undefined,
    onClick: handleClick,
    onDoubleClick: () => onActivate(path),
    onContextMenu: handleContextMenu,
    ...dragProps,
  };

  const nameInput = renaming && onRename && onRenameCancel && (
    <NodeNameInput
      name={entry.name}
      onCommit={(name) => onRename(path, name)}
      onCancel={() => onRenameCancel(path)}
      centered={view === 'icons'}
    />
  );

  if (view === 'icons') {
    return (
      <div
        {...common}
        style={{
          ...elementProps.style,
          width: 104,
          padding: 6,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
          opacity: cut ? 0.5 : 1,
        }}
        title={path}
      >
        <NodeIcon entry={entry} path={path} size={TILE_ICON} picture badge />
        {nameInput || <Text size='xs' ff='monospace' ta='center' lineClamp={2} style={{ wordBreak: 'break-word' }}>{label}</Text>}
      </div>
    );
  }

  // A node the reader may not list gets a lock where its chevron would be —
  // one that holds something or is meant to, not every file without an x bit.
  const locked = (entry.childCount > 0 || isContainer(entry)) && !canList(entry.node.props, access);
  const chevron = locked
    ? (
      <span
        title='You do not have permission to open this'
        style={{ width: ICON_SIZE, flexShrink: 0, display: 'flex', justifyContent: 'center', color: 'var(--mantine-color-dimmed)' }}
      >
        <IconLock size={13} />
      </span>
    )
    : hasChildren
    ? (
      <ActionIcon variant='subtle' color='gray' size={ICON_SIZE} onClick={toggle} aria-label={expanded ? 'Collapse' : 'Expand'} tabIndex={-1}>
        {isLoading ? <Loader size={10} /> : (
          <IconChevronRight
            size={14}
            style={{ transform: expanded ? 'rotate(90deg)' : undefined, transition: 'transform var(--mrx-dur-fast) var(--mrx-ease)' }}
          />
        )}
      </ActionIcon>
    )
    : <span style={{ width: ICON_SIZE, flexShrink: 0 }} />;

  const name = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, paddingLeft: (level - 1) * INDENT }}>
      {chevron}
      <NodeIcon entry={entry} path={path} size={ICON_SIZE} picture />
      {nameInput || <Text size='sm' ff='monospace' truncate style={{ minWidth: 0 }}>{label}</Text>}
      {entry.node.props.softlink && <Text size='xs' ff='monospace' c='dimmed' truncate style={{ minWidth: 0 }}>→ {entry.node.props.softlink}</Text>}
      {loadError && <Text size='xs' c='red' truncate title={loadError.message}>{describeNodeError(loadError)}</Text>}
    </div>
  );

  if (view === 'list') {
    return (
      <div {...common} style={{ ...elementProps.style, padding: '2px 6px', opacity: cut ? 0.5 : 1 }} title={path}>
        {name}
      </div>
    );
  }

  const { props, attrs } = entry.node;
  const cell = (text: string) => <Text size='sm' c='dimmed' truncate ff='monospace'>{text}</Text>;
  return (
    <div
      {...common}
      style={{
        ...elementProps.style,
        display: 'grid',
        gridTemplateColumns: DETAIL_COLUMNS,
        alignItems: 'center',
        columnGap: 12,
        padding: '2px 6px',
        opacity: cut ? 0.5 : 1,
      }}
      title={path}
    >
      {name}
      {cell(nodeTypeLabel(entry))}
      {cell(attrs.size === undefined ? (entry.childCount > 0 ? `${entry.childCount} ${entry.childCount === 1 ? 'item' : 'items'}` : '—') : formatBytes(attrs.size))}
      {cell(modeString(props.mode) + (props.acl?.length ? '+' : ''))}
      {cell(names.users.get(props.uid) ?? String(props.uid))}
      {cell(names.groups.get(props.gid) ?? String(props.gid))}
      {cell(formatWhen(toMillis(props.modtime?.timestamp)))}
    </div>
  );
}
