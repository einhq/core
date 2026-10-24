import { Menu } from '@mantine/core';
import {
  IconArrowsMove,
  IconClipboard,
  IconCopy,
  IconCut,
  IconExternalLink,
  IconFolderOpen,
  IconFolderPlus,
  IconInfoCircle,
  IconPencil,
  IconRefresh,
  IconTerminal2,
  IconTrash,
} from '@tabler/icons-react';

export type ContextMenuState = {
  x: number;
  y: number;
  /** The node under the pointer, or `null` for the tab's directory itself. */
  path: string | null;
};

type ContextMenuActions = {
  drill: () => void;
  open: () => void;
  cut: () => void;
  copy: () => void;
  paste: () => void;
  rename: () => void;
  remove: () => void;
  mkdir: () => void;
  properties: () => void;
  refresh: () => void;
  terminal: () => void;
};

type NodeContextMenuProps = {
  state: ContextMenuState | null;
  onClose: () => void;
  /** How many rows the menu acts on; rename and open want exactly one. */
  count: number;
  canOpen: boolean;
  canPaste: boolean;
  /** Whether the current user may write here; the server decides for real. */
  writable: boolean;
  actions: ContextMenuActions;
};

/**
 * The right-click menu, anchored to a point rather than a control.
 *
 * Mantine positions a dropdown against its target element, so the target is
 * an empty box parked at the pointer. Menu items never navigate away by
 * themselves: "Open" goes where the node's own page or viewer is — the code
 * editor for a text file.
 *
 * The menu does not hand focus back when it closes: Mantine would take it
 * from whatever an item just focused — the rename field in the row — so
 * `onClose`'s owner decides where it goes.
 */
export function NodeContextMenu({ state, onClose, count, canOpen, canPaste, writable, actions }: NodeContextMenuProps) {
  const onNode = state?.path !== null;
  const single = count === 1;
  const item = (label: string, icon: React.ReactNode, action: () => void, disabled = false, shortcut?: string) => (
    <Menu.Item
      leftSection={icon}
      rightSection={shortcut ? <span style={{ fontSize: 11, color: 'var(--mantine-color-dimmed)' }}>{shortcut}</span> : undefined}
      disabled={disabled}
      onClick={() => {
        onClose();
        action();
      }}
    >
      {label}
    </Menu.Item>
  );

  return (
    <Menu
      opened={state !== null}
      onChange={(opened) => !opened && onClose()}
      position='bottom-start'
      shadow='md'
      withinPortal
      offset={2}
      returnFocus={false}
    >
      <Menu.Target>
        <div style={{ position: 'fixed', left: state?.x ?? 0, top: state?.y ?? 0, width: 0, height: 0 }} />
      </Menu.Target>
      <Menu.Dropdown>
        {onNode && (
          <>
            {item('Drill in', <IconFolderOpen size={14} />, actions.drill, !single, 'Enter')}
            {item('Open', <IconExternalLink size={14} />, actions.open, !single || !canOpen)}
            <Menu.Divider />
            {item('Cut', <IconCut size={14} />, actions.cut, !writable, 'Ctrl+X')}
            {item('Copy', <IconCopy size={14} />, actions.copy, false, 'Ctrl+C')}
          </>
        )}
        {item('Paste', <IconClipboard size={14} />, actions.paste, !canPaste || !writable, 'Ctrl+V')}
        <Menu.Divider />
        {onNode && item('Rename', <IconPencil size={14} />, actions.rename, !single || !writable, 'F2')}
        {onNode && item('Delete', <IconTrash size={14} />, actions.remove, !writable, 'Del')}
        {item('New directory', <IconFolderPlus size={14} />, actions.mkdir, !writable)}
        <Menu.Divider />
        {onNode && item('Properties', <IconInfoCircle size={14} />, actions.properties, !single, 'Alt+Enter')}
        {item('Open terminal here', <IconTerminal2 size={14} />, actions.terminal)}
        {item('Refresh', <IconRefresh size={14} />, actions.refresh, false, 'F5')}
        {onNode && count > 1 && (
          <Menu.Label>
            <IconArrowsMove size={12} style={{ verticalAlign: -2 }} /> {count} selected
          </Menu.Label>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
