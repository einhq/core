import { ActionIcon, Avatar, Badge, Box, Button, Group, Kbd, Menu, Stack, Text, ThemeIcon, Tooltip, UnstyledButton } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import {
  IconArrowsMove,
  IconDots,
  IconInfoCircle,
  IconKeyboard,
  IconLogin2,
  IconLogout,
  IconPlugConnectedX,
  IconShieldFilled,
  IconShieldOff,
  IconShieldUp,
  IconTerminal2,
  IconUser,
} from '@tabler/icons-react';
import {
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
import { keyCaps, shortcutHelpOpen, shortcutText, topbarShortcuts } from '../../signals/shortcuts.ts';
import { useNavKeys } from '../../hooks/useNavKeys.ts';
import { movableEntry, type NavSpot } from '../../lib/nav-arrange.ts';
import { ACCOUNT_MENU, navArrangeState, navArranging, resetNavArrangement } from '../../signals/nav-arrange.ts';
import { ArrangeItem, useArrangeZone } from './NavArrange.tsx';

/** How many of the configured buttons the right of the top bar holds before the rest go under More. */
const TOPBAR_ROOM = 8;
const PHONE_TOPBAR_ROOM = 3;

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

  const visibleFrom = entry.phone === false ? 'sm' : undefined;

  // Arranging, the button is only something to move: every entry shows, and none opens.
  if (navArranging.value) {
    return (
      <ActionIcon variant='subtle' color={entry.color ?? 'gray'} size={buttonSize} aria-label={entry.title} component='div'>
        <TablerIcon name={entry.icon} size={iconSize} />
      </ActionIcon>
    );
  }

  if (stepsAside(entry, pathname)) return null;

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

type ItemProps = { phone: boolean; busy: ReadonlySet<string>; run: (entry: ResolvedTopbarEntry) => void };

/**
 * A part of the top bar its configured entries stand in: beside the search box, or on the right.
 * Arranging, it is a place to drop entries and each one is moved rather than opened. Otherwise the
 * right holds as many as there is room for (`room`) and the rest go under More.
 */
function TopbarZone({ spot, entries, room, ...item }: ItemProps & { spot: NavSpot; entries: ResolvedTopbarEntry[]; room?: number }) {
  useSignals();
  const { zone, mark } = useArrangeZone(spot, 'x');
  if (navArranging.value) {
    return (
      <Group gap={item.phone ? 4 : 'xs'} wrap='nowrap' {...zone}>
        {entries.map((entry, i) => (
          <ArrangeItem key={`${entry.list}:${entry.id}`} entry={movableEntry(entry)} spot={spot} label={entry.title} mark={mark(i, entries.length)}>
            <TopbarItem entry={entry} phone={item.phone} busy={false} run={item.run} />
          </ArrangeItem>
        ))}
      </Group>
    );
  }
  // What a phone draws counts against its room; what it leaves out (`phone: false`) does not.
  const drawn = item.phone ? entries.filter((entry) => entry.phone !== false) : entries;
  const more = room !== undefined && drawn.length > room ? drawn.slice(room - 1) : [];
  const inBar = entries.filter((entry) => !more.includes(entry));
  return (
    <>
      {inBar.map((entry) => <TopbarItem key={`${entry.list}:${entry.id}`} entry={entry} phone={item.phone} busy={item.busy.has(entry.id)} run={item.run} />)}
      {more.length > 0 && <MoreMenu entries={more} {...item} />}
    </>
  );
}

/** The top bar's entries there was no room for, as rows; a dropdown's rows under its heading. */
function MoreMenu({ entries, phone, run }: ItemProps & { entries: ResolvedTopbarEntry[] }) {
  return (
    <Menu shadow='md' width={phone ? 260 : 220}>
      <Menu.Target>
        <Tooltip label='More'>
          <ActionIcon variant='subtle' color='gray' size={phone ? 36 : undefined} aria-label='More'>
            <IconDots size={phone ? 22 : 18} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown className='mrx-topbar-menu'>
        {entries.flatMap((entry) =>
          entry.menu
            ? [
              <Menu.Label key={`${entry.list}:${entry.id}`}>{entry.label ?? entry.title}</Menu.Label>,
              ...entry.menu.map((row) => (
                <Menu.Item key={`${row.list}:${row.id}`} leftSection={rowIcon(row)} rightSection={rowKeys(row)} onClick={() => run(row)}>
                  {row.title}
                </Menu.Item>
              )),
            ]
            : [
              <Menu.Item key={`${entry.list}:${entry.id}`} leftSection={rowIcon(entry)} rightSection={rowKeys(entry)} onClick={() => run(entry)}>
                {entry.title}
              </Menu.Item>,
            ]
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * The account menu's rows while arranging, and what ends it: a place to drop entries, each row
 * moved rather than opened. The shell's own rows (Me, Shortcuts, About, signing out) are not
 * the navigation's, and stand aside meanwhile.
 */
function ArrangeAccountRows({ rows, onDone }: { rows: ResolvedTopbarEntry[]; onDone: () => void }) {
  useSignals();
  const spot: NavSpot = { kind: 'menu', parent: ACCOUNT_MENU };
  const { zone, mark } = useArrangeZone(spot, 'y');
  const { busy, error } = navArrangeState.value;
  return (
    <Box p={4} maw={260}>
      <Text size='sm' fw={600}>Arrange navigation</Text>
      <Text size='xs' c='dimmed' mt={2} mb='xs'>
        Drag entries between the sidebar, the top bar and this menu, or choose one to move it.
      </Text>
      <Stack gap={2} {...zone}>
        {rows.map((row, i) => (
          <ArrangeItem key={`${row.list}:${row.id}`} entry={movableEntry(row)} spot={spot} label={row.title} mark={mark(i, rows.length)}>
            <Group gap='xs' px='xs' py={6} wrap='nowrap'>
              {rowIcon(row)}
              <Text size='sm'>{row.title}</Text>
            </Group>
          </ArrangeItem>
        ))}
      </Stack>
      {error && <Text size='xs' c='red' mt='xs'>{error}</Text>}
      <Group justify='space-between' mt='sm' wrap='nowrap'>
        <Button size='compact-sm' variant='subtle' color='gray' disabled={busy} onClick={() => void resetNavArrangement()}>
          Reset
        </Button>
        <Button
          size='compact-sm'
          loading={busy}
          onClick={() => {
            navArranging.value = false;
            onDone();
          }}
        >
          Done
        </Button>
      </Group>
    </Box>
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

  const arranging = navArranging.value;
  const [accountOpen, setAccountOpen] = useState(false);

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

  // An entry's key does what choosing it does, whether or not its button is drawn (a phone's
  // header leaves some out).
  useNavKeys(
    topbarShortcuts().map(({ entry }) => [
      entry.shortcut,
      () => {
        if (!busy.has(entry.id) && !stepsAside(entry, location.pathname)) run(entry);
      },
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
            {(arranging || besideSearch.length > 0) && <TopbarZone spot={{ kind: 'search' }} entries={besideSearch} phone={phone} busy={busy} run={run} />}
          </>
        )}
      </Group>

      {/* Right section: Actions */}
      <Group gap={phone ? 4 : 'xs'} wrap='nowrap'>
        {
          /* Only when the page's own connection is down, which every page's commands go through;
            the terminal's sessions show theirs on their tabs. A phone has room for the plug alone. */
        }
        {!shellClientConnected.value && (
          phone
            ? (
              <Tooltip label='Disconnected — reconnecting'>
                <ThemeIcon color='red' variant='transparent' size={36} role='status' aria-label='Disconnected'>
                  <IconPlugConnectedX size={22} />
                </ThemeIcon>
              </Tooltip>
            )
            : (
              <Badge size='sm' color='red' variant='dot' role='status' styles={{ root: { color: 'white' } }}>
                Disconnected
              </Badge>
            )
        )}

        {/* Upload indicator (shows when uploads in queue) */}
        <UploadIndicator />

        {!confined && <TopbarZone spot={{ kind: 'topbar' }} entries={actions} room={phone ? PHONE_TOPBAR_ROOM : TOPBAR_ROOM} phone={phone} busy={busy} run={run} />}

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
          <Menu
            shadow='md'
            width={phone ? 260 : arranging ? 260 : 200}
            // Arranging keeps it open, as the place its rows are dropped and the way to end it;
            // closing it (Escape, the avatar) ends arranging.
            opened={arranging || accountOpen}
            onChange={(open) => {
              setAccountOpen(open);
              if (!open) navArranging.value = false;
            }}
            closeOnClickOutside={!arranging}
            closeOnItemClick={!arranging}
          >
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
              {arranging ? <ArrangeAccountRows rows={accountRows} onDone={() => setAccountOpen(false)} /> : (
                <>
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
                    <Menu.Item
                      key={`${row.list}:${row.id}`}
                      leftSection={rowIcon(row)}
                      rightSection={rowKeys(row)}
                      onClick={() => run(row)}
                    >
                      {row.title}
                    </Menu.Item>
                  ))}
                  <Menu.Divider />
                  {!confined && (
                    <Menu.Item leftSection={<IconArrowsMove size={14} />} closeMenuOnClick={false} onClick={() => (navArranging.value = true)}>
                      Arrange navigation
                    </Menu.Item>
                  )}
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
                </>
              )}
            </Menu.Dropdown>
          </Menu>
        )}
        {signedIn && <ElevateDialog opened={elevateOpen} onClose={() => setElevateOpen(false)} />}
      </Group>
    </Group>
  );
}
