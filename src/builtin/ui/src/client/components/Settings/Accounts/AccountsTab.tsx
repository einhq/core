import { ActionIcon, Alert, Box, Button, Paper, Stack, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconChevronLeft, IconUserPlus, IconUsersPlus } from '@tabler/icons-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { GroupEntry, UserEntry } from '@ein/api';
import { useElementWidth } from '../../../hooks/useElementWidth.ts';
import { usePhone } from '../../../hooks/usePhone.ts';
import { usePersistedState } from '../../../hooks/usePersistedState.ts';
import { accountStatus, isPersonalGroup } from '../../../lib/accounts.ts';
import { EmptyState } from '../../EmptyState/EmptyState.tsx';
import { fillWindow, PaneScroll, SPLIT_MIN_WIDTH } from '../ListDetail.tsx';
import { PageLoader } from '../../Layout/PageLoader.tsx';
import { GroupList } from './GroupList.tsx';
import { GroupPanel } from './GroupPanel.tsx';
import { NewGroupPanel } from './NewGroupPanel.tsx';
import { NewUserPanel } from './NewUserPanel.tsx';
import { useAccounts } from './useAccounts.ts';
import { UserList } from './UserList.tsx';
import { UserPanel } from './UserPanel.tsx';

/** The Settings tabs this one shows. */
type AccountsView = 'users' | 'groups';

/**
 * Where the URL puts the page: a Settings tab, and in Users or Groups one entry or the form for a
 * new one. The panels link to Permissions too.
 */
type Place = { tab: AccountsView | 'permissions'; user?: string; group?: string; creating?: boolean };

/** The history state of an entry opened from the list where they take turns, so going back to the list pops it. */
const OPENED = { accountsOpened: true };

const wasOpened = (state: unknown): boolean => (state as { accountsOpened?: unknown } | null)?.accountsOpened === true;

/**
 * The administrator's accounts or groups, as the Settings page's Users and Groups tabs: a list
 * beside the open entry's panel. One stays mounted across both, so the lists, filters and what is
 * loaded carry over from one to the other.
 *
 * Where the tab is wide enough, list and panel fill the window below the page's header and each
 * scrolls by itself, so the page does not; narrower, the list and the panel take turns in the
 * page's own scroll, and opening an entry is a step in the history that Back undoes.
 *
 * What is open lives in the URL (`user`, `group`, `new=1`) beside the page's `tab`, so an account
 * or a group can be linked to. A name that matches nothing opens nothing; side by side, where the
 * panel always has room, nothing open shows the first entry.
 */
export function AccountsTab({ view }: { view: AccountsView }) {
  const { users, groups, sessions, loading, error, run } = useAccounts();
  const [widthRef, width] = useElementWidth<HTMLDivElement>();
  const narrow = width < SPLIT_MIN_WIDTH;
  // On a phone the panel is no box: its sections use the page's width.
  const flat = usePhone();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [personal, setPersonal] = usePersistedState<'true' | 'false'>('settings.accounts.personal', 'false');
  const [disabled, setDisabled] = usePersistedState<'true' | 'false'>('settings.accounts.disabled', 'false');
  const [userFilter, setUserFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  // Why the password of an account just made could not be set, for its panel to say.
  const [passwordProblem, setPasswordProblem] = useState<{ username: string; message: string } | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const aloneRef = useRef<HTMLDivElement>(null);

  const creating = params.get('new') === '1';
  const namedUser = view === 'users' && !creating ? params.get('user') : null;
  const namedGroup = view === 'groups' && !creating ? params.get('group') : null;
  const firstLoad = loading && users.length === 0;
  const opened = wasOpened(location.state);

  // Opening an entry from the list where they take turns is pushed; anything else replaces, and
  // keeps the opened mark while the tab stays, so the way back still pops to the list.
  const go = useCallback((place: Place, push = false) => {
    const next = new URLSearchParams({ tab: place.tab });
    if (place.user) next.set('user', place.user);
    if (place.group) next.set('group', place.group);
    if (place.creating) next.set('new', '1');
    setParams(next, push ? { state: OPENED } : { replace: true, state: opened && place.tab === view && (place.user || place.group || place.creating) ? OPENED : null });
  }, [setParams, opened, view]);

  const backToList = () => (opened ? navigate(-1) : go({ tab: view }));

  useEffect(() => {
    if (passwordProblem && !creating && namedUser !== passwordProblem.username) setPasswordProblem(null);
  }, [creating, namedUser, passwordProblem]);

  const showPersonal = personal === 'true';
  const isPersonal = (group: GroupEntry) => isPersonalGroup(group, users);
  // A personal group opened from elsewhere is listed while it is open, so the list marks it.
  const listedGroups = groups.filter((group) => showPersonal || !isPersonal(group) || group.groupname === namedGroup);
  const showDisabled = disabled === 'true';
  const isDisabled = (user: UserEntry) => accountStatus(user) === 'disabled';
  // So is a disabled account.
  const listedUsers = users.filter((user) => showDisabled || !isDisabled(user) || user.username === namedUser);

  const fallbackFirst = !narrow && !creating;
  const selectedUser: UserEntry | undefined = users.find((user) => user.username === namedUser) ??
    (fallbackFirst ? listedUsers[0] : undefined);
  const selectedGroup: GroupEntry | undefined = groups.find((group) => group.groupname === namedGroup) ??
    (fallbackFirst ? listedGroups[0] : undefined);

  // Narrow, the list and the panel take turns: the panel while something is named or being made.
  const named = view === 'users' ? namedUser : namedGroup;
  const detailAlone = narrow && (creating || (firstLoad ? named !== null : (view === 'users' ? selectedUser : selectedGroup) !== undefined));

  // What the panel shows; when it changes, the panel starts at its top.
  const shown = `${view}:${creating ? 'new' : (view === 'users' ? selectedUser?.username : selectedGroup?.groupname) ?? ''}`;
  const lastShown = useRef(shown);
  useLayoutEffect(() => {
    if (lastShown.current === shown) return;
    lastShown.current = shown;
    if (!narrow) {
      detailRef.current?.scrollTo({ top: 0 });
      return;
    }
    // The page scrolls instead: an entry opened from far down the list is brought up to its top,
    // below the page's stuck header (the box's `scroll-margin-top`).
    const box = aloneRef.current;
    if (detailAlone && box && box.getBoundingClientRect().top < parseFloat(getComputedStyle(box).scrollMarginTop)) {
      box.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [shown, narrow, detailAlone]);

  const newLabel = view === 'users' ? 'New user' : 'New group';
  const newButton = (
    <Tooltip label={newLabel}>
      <ActionIcon size='input-sm' aria-label={newLabel} disabled={creating} onClick={() => go({ tab: view, creating: true }, narrow)}>
        {view === 'users' ? <IconUserPlus size={18} /> : <IconUsersPlus size={18} />}
      </ActionIcon>
    </Tooltip>
  );

  const userDetail = firstLoad ? <PageLoader label='Loading accounts…' /> : creating
    ? (
      <NewUserPanel
        users={users}
        groups={groups}
        run={run}
        onCreated={(username, passwordError) => {
          setPasswordProblem(passwordError ? { username, message: passwordError } : null);
          go({ tab: 'users', user: username });
        }}
        onCancel={backToList}
      />
    )
    : selectedUser
    ? (
      <UserPanel
        key={selectedUser.username}
        user={selectedUser}
        users={users}
        groups={groups}
        sessions={sessions}
        run={run}
        passwordError={passwordProblem?.username === selectedUser.username ? passwordProblem.message : undefined}
        onDeleted={backToList}
        onOpenPermissions={() => go({ tab: 'permissions' })}
      />
    )
    : <EmptyState title='Nobody to show'>Pick an account in the list, or make a new one.</EmptyState>;

  const groupDetail = firstLoad ? <PageLoader label='Loading groups…' /> : creating
    ? (
      <NewGroupPanel
        users={users}
        groups={groups}
        run={run}
        onCreated={(groupname) => go({ tab: 'groups', group: groupname })}
        onCancel={backToList}
      />
    )
    : selectedGroup
    ? (
      <GroupPanel
        key={selectedGroup.groupname}
        group={selectedGroup}
        users={users}
        groups={groups}
        run={run}
        onDeleted={backToList}
        onOpenUser={(username) => go({ tab: 'users', user: username })}
      />
    )
    : <EmptyState title='No group to show'>Pick a group in the list, or make a new one.</EmptyState>;

  const list = view === 'users'
    ? (
      <UserList
        users={listedUsers}
        sessions={sessions}
        selected={creating ? undefined : selectedUser?.username}
        onSelect={(username) => go({ tab: 'users', user: username }, narrow)}
        filter={userFilter}
        onFilter={setUserFilter}
        loading={firstLoad}
        action={newButton}
        scrolls={!narrow}
        showDisabled={showDisabled}
        onShowDisabled={users.some(isDisabled) ? (next) => setDisabled(next ? 'true' : 'false') : undefined}
      />
    )
    : (
      <GroupList
        groups={listedGroups}
        users={users}
        selected={creating ? undefined : selectedGroup?.groupname}
        onSelect={(groupname) => go({ tab: 'groups', group: groupname }, narrow)}
        filter={groupFilter}
        onFilter={setGroupFilter}
        loading={firstLoad}
        action={newButton}
        scrolls={!narrow}
        showPersonal={showPersonal}
        onShowPersonal={groups.some(isPersonal) ? (next) => setPersonal(next ? 'true' : 'false') : undefined}
      />
    );

  const detail = (
    <Paper withBorder={!flat} bg={flat ? 'transparent' : undefined} radius='md' className='mrx-settings-detail'>
      <PaneScroll scrolls={!narrow} viewportRef={detailRef}>
        <Box p={flat ? 0 : narrow ? 'md' : 'lg'}>{view === 'users' ? userDetail : groupDetail}</Box>
      </PaneScroll>
    </Paper>
  );

  const body = detailAlone
    ? (
      <Stack
        ref={aloneRef}
        gap='sm'
        style={{ scrollMarginTop: 'calc(var(--app-shell-header-height, 0px) + var(--mrx-stuck-header-height, 0px) + var(--mantine-spacing-sm))' }}
      >
        <Box>
          <Button variant='subtle' color='gray' size='compact-sm' leftSection={<IconChevronLeft size={16} />} onClick={backToList}>
            {view === 'users' ? 'All users' : 'All groups'}
          </Button>
        </Box>
        {detail}
      </Stack>
    )
    : narrow
    ? list
    : (
      <div ref={fillWindow} className='mrx-settings-split'>
        {list}
        {detail}
      </div>
    );

  return (
    <Stack ref={widthRef} gap='lg'>
      {error && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />}>
          {error.message}
        </Alert>
      )}
      {body}
    </Stack>
  );
}
