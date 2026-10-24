import { Button, Menu } from '@mantine/core';
import { IconShare } from '@tabler/icons-react';
import { openShareModal } from '@ein/ui/signals';

export type ShareButtonProps = {
  path: string;
  compact?: boolean;
  /** Draw as an overflow-menu item instead of a persistent header button. */
  menuItem?: boolean;
};

/**
 * Opens the sharing dialog for one node.
 *
 * Only asks for the dialog; `ShareModalHost` draws it at the app root. The
 * dialog reads nothing until it is opened, so a page can carry this next to its
 * title without paying for a user and group listing it may never show.
 */
export function ShareButton({ path, compact, menuItem = false }: ShareButtonProps) {
  const open = () => openShareModal(path);

  return menuItem ? <Menu.Item leftSection={<IconShare size={16} />} onClick={open}>Share</Menu.Item> : (
    <Button
      variant='light'
      size={compact ? 'compact-sm' : 'sm'}
      leftSection={<IconShare size={compact ? 14 : 16} />}
      onClick={open}
    >
      Share
    </Button>
  );
}
