import { ActionIcon, Avatar, Badge, Box, Button, Group, Kbd, Menu, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { useSignals } from '@preact/signals-react/runtime';
import {
  IconInfoCircle,
  IconKeyboard,
  IconLogin2,
  IconLogout,
  IconShieldFilled,
  IconShieldOff,
  IconShieldUp,
  IconTerminal2,
  IconTrash,
  IconUser,
  IconUserCog,
} from '@tabler/icons-react';
import {
  activeTabConnected,
  currentUser,
  drawerShows,
  heldLinkRoutes,
  leaveElevation,
  linkVisitor,
  logout,
  openDialog,
  openRoute,
  type ResolvedTopbarEntry,
  routeBase,
  runNavAction,
  shellClientConnected,
  terminalOpenToggle,
  uiNav,
  underBase,
} from '@ein/ui/signals';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { loginUrlFor } from '../../lib/login-return.ts';
import { HeaderSearch } from './HeaderSearch.tsx';
import { ElevateDialog } from './ElevateDialog.tsx';
import { EinMark } from './EinMark.tsx';
import { UploadIndicator } from '../Upload/UploadIndicator.tsx';
import { CoverAvatar } from '../Cover/CoverAvatar.tsx';
import { usePhone } from '../../hooks/usePhone.ts';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import { keyCaps, matchedPhysically, shortcutHelpOpen, shortcutText, topbarShortcuts } from '../../signals/shortcuts.ts';

/** The shell's dropdown that modules add the reader's own pages to as rows; drawn as the account menu, not as a button of its own. */
const ACCOUNT_MENU = 'ui.account';

/** A dropdown row's icon, in the row's colour when it has one. */
const rowIcon = (row: ResolvedTopbarEntry) => <TablerIcon name={row.icon} size={14} style={row.color ? { color: `var(--mantine-color-${row.color}-4)` } : undefined} />;

/** A dropdown row's key, at its right. */
const rowKeys = (row: ResolvedTopbarEntry) =>
  row.shortcut && (
    <Group gap={2} wrap='nowrap'>
      {keyCaps(row.shortcut).map((cap, i) => <Kbd key={i} size='xs'>{cap}</Kbd>)}
    </Group>
  );

/** The route an entry opens in the drawer, if it does. */
const drawerOf = (entry: ResolvedTopbarEntry): string | undefined => entry.action && 'drawer' in entry.action ? entry.action.drawer : undefined;

/** A drawer's entry steps aside on its route's own page, where the drawer does too: no button, and its key does nothing. */
const stepsAside = (entry: ResolvedTopbarEntry, pathname: string): boolean => {
  const drawer = drawerOf(entry);
  return drawer !== undefined && underBase(pathname, routeBase(drawer));
};

/**
 * One configured top-bar entry (`ui-nav`): a button that runs its action, or a dropdown
 * of rows when it has any. A button that opens a route in the drawer is lit while it is
 * open there. `run` does what an entry says; `busy` is whether it is still at it.
 */
function TopbarItem({ entry, phone, busy, run }: { entry: ResolvedTopbarEntry; phone: boolean; busy: boolean; run: (entry: ResolvedTopbarEntry) => void }) {
  useSignals();
  const { pathname } = useLocation();
  // A phone's header is taller (PHONE_HEADER_HEIGHT) so its buttons can be
  // thumb-sized; the header's gaps shrink to keep all of them on a 360px screen.
  const buttonSize = phone ? 36 : undefined;
  const iconSize = phone ? 22 : 18;

  if (stepsAside(entry, pathname)) return null;

  const visibleFrom = entry.phone === false ? 'sm' : undefined;

  if (entry.menu) {
    return (
      <Menu shadow='md' width={phone ? 260 : 200}>
        <Menu.Target>
          <Tooltip label={entry.title}>
            <ActionIcon size={buttonSize} visibleFrom={visibleFrom} aria-label={entry.title}>
              <TablerIcon name={entry.icon} size={iconSize} />
            </ActionIcon>
          </Tooltip>
        </Menu.Target>
        <Menu.Dropdown className='mrx-topbar-menu'>
          {entry.label && <Menu.Label>{entry.label}</Menu.Label>}
          {entry.menu.map((row) => (
            <Menu.Item key={row.id} leftSection={rowIcon(row)} rightSection={rowKeys(row)} onClick={() => run(row)}>
              {row.title}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    );
  }

  const drawer = drawerOf(entry);
  const active = drawer !== undefined && drawerShows(drawer);
  return (
    <Tooltip label={entry.shortcut ? `${entry.title} (${shortcutText(entry.shortcut)})` : entry.title}>
      <ActionIcon
        variant={active ? 'white' : 'subtle'}
        color={active ? 'marine' : (entry.color ?? 'gray')}
        size={buttonSize}
        visibleFrom={visibleFrom}
        loading={busy}
        aria-label={entry.title}
        aria-keyshortcuts={entry.shortcut}
        onClick={() => run(entry)}
      >
        <TablerIcon name={entry.icon} size={iconSize} />
      </ActionIcon>
    </Tooltip>
  );
}

/**
 * `menuOpen` and `onToggleMenu` are a phone's sidebar: its rail shown, or its
 * labelled list open over the page. The configured entries (`ui-nav`) placed
 * beside the search box stand there, the rest between it and the terminal and
 * account menu, and the rows modules give `ui.account` are in the
 * account menu, under Me. The guest, browsing where the
 * archive is open to it, has neither the terminal nor an account, but a way to sign in.
 * A visitor held to their share link has no sidebar, search or entries either: the
 * mark and the name go back to what the link opens.
 */
export function AppHeader({ menuOpen, onToggleMenu }: { menuOpen: boolean; onToggleMenu: () => void }) {
  useSignals();
  const navigate = useNavigate();
  const location = useLocation();
  const signedIn = currentUser.value !== null;
  const confined = linkVisitor.value;
  const linkHome = heldLinkRoutes.value[0]?.route;
  // The create and account menus are finger targets on a phone: wider, with taller rows.
  const phone = usePhone();
  const entries = uiNav.value.topbar.filter((entry) => entry.id !== ACCOUNT_MENU);
  const besideSearch = entries.filter((entry) => entry.place === 'search');
  const actions = entries.filter((entry) => entry.place !== 'search');
  const accountRows = uiNav.value.topbar.find((entry) => entry.id === ACCOUNT_MENU)?.menu ?? [];

  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const run = (entry: ResolvedTopbarEntry) => {
    if (!entry.action) return;
    // Only an action that takes a while shows it: a spinner flashed for a toggle is noise.
    const slow = setTimeout(() => setBusy((ids) => new Set(ids).add(entry.id)), 150);
    runNavAction(entry.action, { navigate })
      .catch((error) => console.error(`${entry.id} failed`, error))
      .finally(() => {
        clearTimeout(slow);
        setBusy((ids) => new Set([...ids].filter((id) => id !== entry.id)));
      });
  };

  // An entry's key does what choosing it does, from anywhere outside a text field, whether or not
  // its button is drawn (a phone's header leaves some out).
  useHotkeys(
    topbarShortcuts().map(({ entry }) => [
      entry.shortcut,
      () => {
        if (!busy.has(entry.id) && !stepsAside(entry, location.pathname)) run(entry);
      },
      { preventDefault: true, usePhysicalKeys: matchedPhysically(entry.shortcut) },
    ]),
  );

  // A fresh page, so nothing read as this person is left for whoever uses it next.
  const handleLogout = () => void logout().then(() => globalThis.location.replace('/login'));

  // A member of `sudo` may make this sign-in the administrator's, and leave it again; either way the
  // page loads again, since the navigation and settings were read as the other.
  const elevated = currentUser.value?.elevated === true;
  const mayElevate = currentUser.value?.mayElevate === true && !elevated;
  const [elevateOpen, setElevateOpen] = useState(false);
  const handleLeaveElevation = () =>
    void leaveElevation()
      .then(() => globalThis.location.reload())
      .catch((error) => console.error('leaving admin mode failed', error));

  return (
    <Group h='100%' px={phone ? 'sm' : 'md'} gap={phone ? 'xs' : 'md'} justify='space-between' wrap='nowrap'>
      {/* Left: Logo, sized to the sidebar so the search box lands on the content edge */}
      <Group wrap='nowrap' className='mrx-header-brand'>
        {
          /* On a phone the mark is the sidebar's switch, in place of a burger:
            it shows and hides the rail, or opens and closes the labelled list.
            Home is the sidebar's first entry there. On a desktop it goes home. */
        }
        <UnstyledButton
          onClick={confined ? () => navigate(linkHome ?? '/') : phone ? onToggleMenu : () => navigate('/')}
          aria-label={confined ? 'Back to what was shared with you' : phone ? (menuOpen ? 'Hide menu' : 'Show menu') : 'EiN home'}
          aria-expanded={phone && !confined ? menuOpen : undefined}
          p={phone ? 5 : undefined}
          m={phone ? -5 : undefined}
        >
          <Group gap={8} wrap='nowrap'>
            <EinMark size={phone ? 26 : undefined} />
            {/* On a phone the mark alone is the brand, the name's width going to the search box; a visitor held to their link has no search box. */}
            {(!phone || confined) && (
              <Text size='lg' fw={700} c='white' style={{ fontFamily: '"Mochiy Pop One", sans-serif' }}>
                EiN
              </Text>
            )}
          </Group>
        </UnstyledButton>
      </Group>

      {/* Center section: Search and the entries placed beside it. On a phone it takes all the room between the mark and the actions. */}
      <Group gap={phone ? 4 : 'xs'} wrap='nowrap' style={{ flex: 1, minWidth: 0 }} maw={phone ? undefined : 500} mr={phone ? 0 : 'lg'}>
        {!confined && (
          <>
            <Box style={{ flex: 1, minWidth: 0 }}>
              <HeaderSearch />
            </Box>
            {besideSearch.map((entry) => <TopbarItem key={entry.id} entry={entry} phone={phone} busy={busy.has(entry.id)} run={run} />)}
          </>
        )}
      </Group>

      {/* Right section: Actions */}
      <Group gap={phone ? 4 : 'xs'} wrap='nowrap'>
        {/* Connection status - only show when disconnected: the terminal's, or for the guest, who has none, the page's own */}
        {!(signedIn ? activeTabConnected.value : shellClientConnected.value) && (
          <Badge
            size='sm'
            color='red'
            variant='dot'
            visibleFrom='sm'
            styles={{ root: { color: 'white' } }}
          >
            Disconnected
          </Badge>
        )}

        {/* Upload indicator (shows when uploads in queue) */}
        <UploadIndicator />

        {!confined && actions.map((entry) => <TopbarItem key={entry.id} entry={entry} phone={phone} busy={busy.has(entry.id)} run={run} />)}

        {/* The terminal is the shell's own, like search and the account menu. */}
        {signedIn && (
          <Tooltip label='Toggle Terminal (Alt+T)'>
            <ActionIcon
              variant='subtle'
              color='gray'
              size={phone ? 36 : undefined}
              visibleFrom='sm'
              onClick={terminalOpenToggle}
              data-terminal-toggle
              aria-label='Toggle Terminal (Alt+T)'
            >
              <IconTerminal2 size={phone ? 22 : 18} />
            </ActionIcon>
          </Tooltip>
        )}

        {!signedIn && (
          <Button
            variant='light'
            size={phone ? 'compact-md' : 'compact-sm'}
            leftSection={<IconLogin2 size={phone ? 18 : 16} />}
            onClick={() => navigate(loginUrlFor(location.pathname + location.search + location.hash))}
          >
            Sign in
          </Button>
        )}

        {
          /* User menu — the avatar is the identity; the name rides in the tooltip. An elevated
            sign-in rings it in orange, with a shield at its lower left. */
        }
        {signedIn && (
          <Menu shadow='md' width={phone ? 260 : 200}>
            <Menu.Target>
              <Tooltip label={elevated ? `${currentUser.value?.name ?? 'Account'} (administrator)` : currentUser.value?.name ?? 'Account'}>
                <UnstyledButton
                  pos='relative'
                  aria-label={currentUser.value?.name ?? 'Account'}
                  style={elevated ? { borderRadius: '50%', outline: '2px solid var(--mantine-color-orange-6)', outlineOffset: 2 } : undefined}
                >
                  {currentUser.value?.personPath
                    ? (
                      <CoverAvatar
                        path={currentUser.value.personPath}
                        fallback={currentUser.value.name?.charAt(0)}
                        fallbackSrc={currentUser.value.avatarUrl}
                        size={phone ? 38 : 32}
                        radius='xl'
                        color='gray'
                        alt={currentUser.value.name}
                        eager
                      />
                    )
                    : (
                      <Avatar
                        src={currentUser.value?.avatarUrl}
                        size={phone ? 38 : 'sm'}
                        radius='xl'
                        color='gray'
                      >
                        {currentUser.value?.name?.charAt(0)}
                      </Avatar>
                    )}
                  {elevated && (
                    <Box
                      aria-hidden
                      pos='absolute'
                      left={-5}
                      bottom={-5}
                      w={phone ? 18 : 16}
                      h={phone ? 18 : 16}
                      bg='orange.6'
                      c='white'
                      style={{
                        borderRadius: '50%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        // A cut-out edge in the header's own colour parts the shield from the ring.
                        boxShadow: '0 0 0 2px var(--mrx-surface-chrome)',
                      }}
                    >
                      <IconShieldFilled size={phone ? 11 : 10} />
                    </Box>
                  )}
                </UnstyledButton>
              </Tooltip>
            </Menu.Target>
            <Menu.Dropdown className='mrx-topbar-menu'>
              <Menu.Label>Account</Menu.Label>
              {currentUser.value?.personPath && (
                <Menu.Item
                  leftSection={<IconUser size={14} />}
                  onClick={() => {
                    const user = currentUser.value;
                    // The link is the person's node path; their page is whichever module gives one.
                    const route = user?.personPath ? openRoute('person', user.personPath) : null;
                    if (route) navigate(route);
                  }}
                >
                  Me
                </Menu.Item>
              )}
              {!confined && accountRows.map((row) => (
                <Menu.Item key={row.id} leftSection={rowIcon(row)} rightSection={rowKeys(row)} onClick={() => run(row)}>
                  {row.title}
                </Menu.Item>
              ))}
              <Menu.Item
                leftSection={<IconUserCog size={14} />}
                onClick={() => navigate('/profile')}
              >
                Profile
              </Menu.Item>
              {/* The reader's own trash: visited now and then, so here rather than in the sidebar. */}
              <Menu.Item leftSection={<IconTrash size={14} />} onClick={() => navigate('/trash')}>
                Trash
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item leftSection={<IconKeyboard size={14} />} rightSection={<Kbd size='xs'>?</Kbd>} onClick={() => (shortcutHelpOpen.value = true)}>
                Shortcuts
              </Menu.Item>
              <Menu.Item leftSection={<IconInfoCircle size={14} />} onClick={() => openDialog('/about')}>
                About EiN
              </Menu.Item>
              <Menu.Divider />
              {mayElevate && (
                <Menu.Item leftSection={<IconShieldUp size={14} />} onClick={() => setElevateOpen(true)}>
                  Administer…
                </Menu.Item>
              )}
              {elevated && (
                <Menu.Item leftSection={<IconShieldOff size={14} />} onClick={handleLeaveElevation}>
                  Leave admin mode
                </Menu.Item>
              )}
              <Menu.Item
                leftSection={<IconLogout size={14} />}
                onClick={handleLogout}
              >
                Logout
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
        {signedIn && <ElevateDialog opened={elevateOpen} onClose={() => setElevateOpen(false)} />}
      </Group>
    </Group>
  );
}
