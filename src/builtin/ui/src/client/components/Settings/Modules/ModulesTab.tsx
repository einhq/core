import { Alert, Box, Button, Paper, Stack } from '@mantine/core';
import { IconAlertTriangle, IconChevronLeft, IconPackages, IconPlus } from '@tabler/icons-react';
import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useElementWidth } from '../../../hooks/useElementWidth.ts';
import { usePhone } from '../../../hooks/usePhone.ts';
import { usePersistedState } from '../../../hooks/usePersistedState.ts';
import { useModuleReference } from '../../../hooks/useReference.ts';
import { useAccessIds } from '../../../hooks/useAccessIds.ts';
import { reloadModuleUi } from '../../../signals/nav.ts';
import { EmptyState } from '../../EmptyState/EmptyState.tsx';
import { PageLoader } from '../../Layout/PageLoader.tsx';
import { fillWindow, PaneScroll, SPLIT_MIN_WIDTH } from '../ListDetail.tsx';
import { byState, ModuleList, moduleState } from './ModuleList.tsx';
import { ModulePanel } from './ModulePanel.tsx';
import { AddModule } from './AddModule.tsx';
import { InstallProgress, useModuleInstall } from './ModuleInstall.tsx';
import { useModuleUpdates } from './useModuleUpdates.ts';

/** The history state of a module opened from the list where they take turns, so going back to the list pops it. */
const OPENED = { modulesOpened: true };

const wasOpened = (state: unknown): boolean => (state as { modulesOpened?: unknown } | null)?.modulesOpened === true;

/**
 * The installed modules, as the Settings page's Modules tab: a list beside the open module's
 * panel, laid out as Users and Groups are. Where the tab is wide enough, list and panel fill the
 * window below the page's header and each scrolls by itself; narrower, they take turns in the
 * page's own scroll, and opening a module is a step in the history that Back undoes.
 *
 * The open module is the URL's `module` and its panel's tab is `section`, so either can be linked
 * to; side by side, nothing named shows the first. `published=1` opens the panel that installs a
 * module instead, which the button beside the filter does: Install for the administrator, Published
 * for anyone else, who sees what there is but cannot install it. The list is asked fresh rather
 * than reused from the docs' kept answer: a `mod setup` since then changes whether a module works,
 * and an install or a removal here asks it again, and loads the shell's navigation and module pages
 * again.
 *
 * Above them, the module install EiN is running, whoever started it, and when one this page saw
 * running ends, what it came to. For the administrator `mod outdated` is asked as the tab opens and
 * after each install, so the list marks a module with something newer and its Update says what.
 */
export function ModulesTab() {
  const { data: modules, loading, error, refetch: refetchList } = useModuleReference({ fresh: true });
  const admin = useAccessIds()?.admin === true;
  const { updateOf, refresh: refreshUpdates } = useModuleUpdates(admin);
  // A module installed, updated or removed changes the shell's navigation and pages too.
  const refetch = () => {
    refetchList();
    void reloadModuleUi();
  };
  const { install, seen, refresh: refreshInstall } = useModuleInstall(() => {
    refetch();
    refreshUpdates();
  });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const shownInstall = install && (install.state === 'running' || (seen && dismissed !== install.id)) ? install : null;
  const [widthRef, width] = useElementWidth<HTMLDivElement>();
  const narrow = width < SPLIT_MIN_WIDTH;
  // On a phone the panel is no box: its sections use the page's width.
  const flat = usePhone();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [active, setActive] = usePersistedState<'true' | 'false'>('settings.modules.active', 'false');
  const [filter, setFilter] = useState('');
  const detailRef = useRef<HTMLDivElement>(null);
  const aloneRef = useRef<HTMLDivElement>(null);

  const published = params.get('published') === '1';
  const named = published ? null : params.get('module');
  const section = params.get('section');
  const firstLoad = loading && !modules;
  const opened = wasOpened(location.state);
  const all = (modules ?? []).toSorted(byState);
  const activeOnly = active === 'true';
  // A module that does not work, opened from elsewhere, is listed while it is open, so the list marks it.
  const listed = all.filter((module) => !activeOnly || moduleState(module) === 'active' || module.name === named);
  const selected = published ? undefined : all.find((module) => module.name === named) ?? (narrow ? undefined : listed[0]);

  // Opening a module from the list where they take turns is pushed; anything else replaces, and
  // keeps the opened mark, so the way back still pops to the list. The panel's tab carries over
  // from one module to the next.
  const go = (name: string | null, push = false, tab = section, showPublished = false) => {
    const next = new URLSearchParams({ tab: 'modules' });
    if (showPublished) next.set('published', '1');
    else if (name) next.set('module', name);
    if (!showPublished && tab && tab !== 'overview') next.set('section', tab);
    setParams(next, push ? { state: OPENED } : { replace: true, state: opened && (name || showPublished) ? OPENED : null });
  };
  const backToList = () => (opened ? navigate(-1) : go(null));

  const detailAlone = narrow && (published || (firstLoad ? named !== null : selected !== undefined));

  // When the open module changes, its panel starts at its top.
  const shown = published ? '\0published' : selected?.name ?? '';
  const lastShown = useRef(shown);
  useLayoutEffect(() => {
    if (lastShown.current === shown) return;
    lastShown.current = shown;
    if (!narrow) {
      detailRef.current?.scrollTo({ top: 0 });
      return;
    }
    // The page scrolls instead: a module opened from far down the list is brought up to its top,
    // below the page's stuck header (the box's `scroll-margin-top`).
    const box = aloneRef.current;
    if (detailAlone && box && box.getBoundingClientRect().top < parseFloat(getComputedStyle(box).scrollMarginTop)) {
      box.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [shown, narrow, detailAlone]);

  const list = (
    <ModuleList
      modules={listed}
      selected={selected?.name}
      onSelect={(name) => go(name, narrow)}
      hasUpdate={admin ? (module) => updateOf(module).state === 'behind' : undefined}
      filter={filter}
      onFilter={setFilter}
      loading={firstLoad}
      action={
        <Button
          size='sm'
          variant={published ? 'light' : admin ? 'filled' : 'default'}
          leftSection={admin ? <IconPlus size={16} /> : <IconPackages size={16} />}
          aria-pressed={published}
          onClick={() => go(null, narrow, section, true)}
          style={{ flex: 'none' }}
        >
          {admin ? 'Install' : 'Published'}
        </Button>
      }
      scrolls={!narrow}
      activeOnly={activeOnly}
      onActiveOnly={(next) => setActive(next ? 'true' : 'false')}
    />
  );

  const detail = (
    <Paper withBorder={!flat} bg={flat ? 'transparent' : undefined} radius='md' className='mrx-settings-detail' data-flat={flat || undefined}>
      <PaneScroll scrolls={!narrow} viewportRef={detailRef}>
        <Box
          p={flat ? 0 : narrow ? 'md' : 'lg'}
          // How far the box's edges are, for the module panel's header to reach them: its padding, and
          // beside the list the scroll area's gutter for its scrollbar.
          style={{
            '--mrx-detail-pad': flat ? '0px' : `var(--mantine-spacing-${narrow ? 'md' : 'lg'})`,
            '--mrx-detail-gutter': narrow ? '0px' : 'var(--scrollarea-scrollbar-size, 0px)',
          } as CSSProperties}
        >
          {published
            ? <AddModule installed={all} install={install} onStarted={refreshInstall} onOpenModule={(name) => go(name)} />
            : firstLoad
            ? <PageLoader label='Loading modules…' />
            : selected
            ? (
              <ModulePanel
                key={selected.name}
                module={selected}
                modules={all}
                onOpenModule={(name) => go(name)}
                section={section}
                onSection={(next) => go(selected.name, false, next)}
                onChanged={refetch}
                install={install}
                update={updateOf(selected)}
                onStarted={refreshInstall}
                onRemoved={() => {
                  refetch();
                  backToList();
                }}
              />
            )
            : <EmptyState title='No module to show'>Pick a module in the list{admin ? ', or install one' : ''}.</EmptyState>}
        </Box>
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
            All modules
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
      {shownInstall && <InstallProgress install={shownInstall} onOpenModule={(name) => go(name)} onDismiss={() => setDismissed(shownInstall.id)} />}
      {body}
    </Stack>
  );
}
