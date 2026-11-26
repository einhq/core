import { ActionIcon, Box, Button, Group, Loader, type MantineColor, Menu, Tooltip } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import { Fragment, type RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { TrashPutResult } from '@ein/api';
import { useShowNearby } from '../../hooks/useShowNearby.ts';
import { shq } from '../../lib/shquote.ts';
import { notify } from '../../signals/notify.ts';
import { openShareModal } from '../../signals/share.ts';
import { execCommand } from '../../signals/shell-client.ts';
import type { ShowOnTarget } from '../../signals/show-on.ts';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import type { UploadDropzoneProps } from '../Upload/UploadDropzone.tsx';

/** One of a page's own actions, beside the ones every page names the same way (`PageActions`). */
export type PageAction = {
  label: string;
  /** A Tabler icon name. */
  icon: string;
  onClick: () => void;
  color?: MantineColor;
  disabled?: boolean;
  /** A button in the header's corner, after Edit, rather than an item under ⋮. */
  button?: boolean;
  /** A button in the header's corner before Share, where Upload stands: the page's own way of adding to it. */
  lead?: boolean;
  /** As a button, its icon alone, the label its tooltip. */
  iconOnly?: boolean;
  /** As a button, beside ⋮ on a phone too, rather than folded into it. */
  stays?: boolean;
  /** Busy: a spinner in place of its icon, and not to be pressed again. */
  loading?: boolean;
  /** In the accent colour, as a button: waiting for the next press, or what it started is under way. */
  active?: boolean;
};

/**
 * What can be done to what a page shows, laid out the same on every page: Upload (or the page's
 * own `lead` buttons), Share and Edit as buttons in the header's corner, in that order, then the
 * page's own buttons and the cast icon for a screen near the browser, then ⋮ with the page's own
 * items and Move to trash last. On a phone, and scrolled down in the header's last row, ⋮ has all
 * of them in it but the cast icon, which stays beside it.
 */
export type PageActions = {
  /** Files into a directory: Upload, and a drop target over the window. */
  upload?: UploadDropzoneProps;
  /** The node Share opens the sharing dialog for. */
  share?: string;
  /** Opens the edit dialog. */
  edit?: () => void;
  /** What the cast icon shows on a screen near the browser (`useShowNearby`); none where it cannot go to one. */
  nearby?: ShowOnTarget;
  /** The page's own actions, in order; under ⋮ unless `button`. */
  items?: PageAction[];
  /**
   * Move to trash: the node goes to the reader's trash and the page to `leaveTo`, and the toast's
   * Undo puts it back and returns here.
   */
  trash?: { path: string; name: string; leaveTo: string };
};

/** The actions as one list in three groups — the buttons, the page's items, the trash — each in order. */
type ActionGroups = [PageAction[], PageAction[], PageAction[]];

/**
 * `actions` as `ActionGroups`, Upload raising the file picker through `openUpload`.
 */
export function useActionGroups(actions: PageActions | undefined, openUpload: RefObject<(() => void) | null>): ActionGroups {
  const navigate = useNavigate();
  const location = useLocation();
  const nearby = useShowNearby(actions?.nearby);
  if (!actions) return [[], [], []];
  const { upload, share, edit, items = [], trash } = actions;

  const moveToTrash = async (target: NonNullable<PageActions['trash']>) => {
    const back = `${location.pathname}${location.search}`;
    try {
      const { entries } = await execCommand<TrashPutResult>(`trash put ${shq(target.path)}`);
      navigate(target.leaveTo);
      notify({
        message: `${target.name} moved to the trash`,
        action: {
          label: 'Undo',
          onClick: () => void execCommand(`trash restore ${entries.map((entry) => shq(entry.id)).join(' ')}`).then(() => navigate(back)),
        },
      });
    } catch (err) {
      notify({ message: err instanceof Error ? err.message : String(err), color: 'red' });
    }
  };

  const buttons: PageAction[] = [
    ...(upload ? [{ label: 'Upload', icon: 'upload', disabled: upload.disabled, onClick: () => openUpload.current?.() }] : []),
    ...items.filter((item) => item.lead),
    ...(share ? [{ label: 'Share', icon: 'share', onClick: () => openShareModal(share) }] : []),
    ...(edit ? [{ label: 'Edit', icon: 'pencil', onClick: edit }] : []),
    ...items.filter((item) => item.button && !item.lead),
    ...(nearby ? [{ ...nearby, iconOnly: true, stays: true }] : []),
  ];
  const menu = items.filter((item) => !item.button && !item.lead);
  const last: PageAction[] = trash ? [{ label: 'Move to trash', icon: 'trash', color: 'red', onClick: () => void moveToTrash(trash) }] : [];
  return [buttons, menu, last];
}

/** ⋮ with `groups`, a divider between each that has items. */
export function ActionsMenu({ groups, label = 'More actions' }: { groups: PageAction[][]; label?: string }) {
  const shown = groups.filter((group) => group.length > 0);
  if (shown.length === 0) return null;
  return (
    <Menu position='bottom-end' shadow='md' withinPortal>
      <Menu.Target>
        <ActionIcon variant='light' size='lg' aria-label={label}>
          <IconDotsVertical size={18} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown className='mrx-entity-header-menu-dropdown'>
        {shown.map((group, index) => (
          <Fragment key={index}>
            {index > 0 && <Menu.Divider />}
            {group.map((action) => (
              <Menu.Item
                key={action.label}
                leftSection={action.loading ? <Loader size={16} /> : <TablerIcon name={action.icon} size={16} />}
                color={action.color}
                disabled={action.disabled || action.loading}
                onClick={action.onClick}
              >
                {action.label}
              </Menu.Item>
            ))}
          </Fragment>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * The header's corner: the buttons, then ⋮ with the rest. On a phone the buttons fold into ⋮ too,
 * where even as icons they would crowd the title, but for one that `stays` beside it.
 */
export function CornerActions({ groups: [buttons, menu, last] }: { groups: ActionGroups }) {
  return (
    <Group gap='xs' wrap='nowrap'>
      {buttons.map((action) =>
        action.iconOnly
          ? (
            <Tooltip key={`icon:${action.icon}`} label={action.label}>
              <ActionIcon
                className={action.stays ? undefined : 'mrx-header-wide'}
                variant='light'
                size='lg'
                color={action.color}
                disabled={action.disabled}
                loading={action.loading}
                aria-label={action.label}
                onClick={action.onClick}
              >
                <TablerIcon name={action.icon} size={18} color={action.active ? 'var(--mrx-accent)' : undefined} />
              </ActionIcon>
            </Tooltip>
          )
          : (
            <Button
              key={action.label}
              className='mrx-header-wide'
              variant='light'
              size='sm'
              color={action.color}
              disabled={action.disabled}
              leftSection={<TablerIcon name={action.icon} size={16} />}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          )
      )}
      {(menu.length > 0 || last.length > 0) && (
        <Box className='mrx-header-wide'>
          <ActionsMenu groups={[menu, last]} />
        </Box>
      )}
      <Box className='mrx-header-narrow'>
        <ActionsMenu groups={[buttons.filter((action) => !action.stays), menu, last]} />
      </Box>
    </Group>
  );
}
