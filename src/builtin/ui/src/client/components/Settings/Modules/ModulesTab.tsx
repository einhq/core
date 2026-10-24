import { Alert, Box, Button, Paper, Stack } from '@mantine/core';
import { IconAlertTriangle, IconChevronLeft } from '@tabler/icons-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useElementWidth } from '../../../hooks/useElementWidth.ts';
import { usePhone } from '../../../hooks/usePhone.ts';
import { usePersistedState } from '../../../hooks/usePersistedState.ts';
import { useModuleReference } from '../../../hooks/useReference.ts';
import { EmptyState } from '../../EmptyState/EmptyState.tsx';
import { PageLoader } from '../../Layout/PageLoader.tsx';
import { fillWindow, PaneScroll, SPLIT_MIN_WIDTH } from '../ListDetail.tsx';
import { byState, ModuleList, moduleState } from './ModuleList.tsx';
import { ModulePanel } from './ModulePanel.tsx';

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
 * to; side by side, nothing named shows the first. The list is asked fresh rather than reused from the docs' kept answer: a
 * `mod setup` since then changes whether a module works.
 */
export function ModulesTab() {
  const { data: modules, loading, error } = useModuleReference({ fresh: true });
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

  const named = params.get('module');
  const section = params.get('section');
  const firstLoad = loading && !modules;
  const opened = wasOpened(location.state);
  const all = (modules ?? []).toSorted(byState);
  const activeOnly = active === 'true';
  // A module that does not work, opened from elsewhere, is listed while it is open, so the list marks it.
  const listed = all.filter((module) => !activeOnly || moduleState(module) === 'active' || module.name === named);
  const selected = all.find((module) => module.name === named) ?? (narrow ? undefined : listed[0]);

  // Opening a module from the list where they take turns is pushed; anything else replaces, and
  // keeps the opened mark, so the way back still pops to the list. The panel's tab carries over
  // from one module to the next.
  const go = (name: string | null, push = false, tab = section) => {
    const next = new URLSearchParams({ tab: 'modules' });
    if (name) next.set('module', name);
    if (tab && tab !== 'about') next.set('section', tab);
    setParams(next, push ? { state: OPENED } : { replace: true, state: opened && name ? OPENED : null });
  };
  const backToList = () => (opened ? navigate(-1) : go(null));

  const detailAlone = narrow && (firstLoad ? named !== null : selected !== undefined);

  // When the open module changes, its panel starts at its top.
  const shown = selected?.name ?? '';
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
      filter={filter}
      onFilter={setFilter}
      loading={firstLoad}
      scrolls={!narrow}
      activeOnly={activeOnly}
      onActiveOnly={(next) => setActive(next ? 'true' : 'false')}
    />
  );

  const detail = (
    <Paper withBorder={!flat} bg={flat ? 'transparent' : undefined} radius='md' className='mrx-settings-detail'>
      <PaneScroll scrolls={!narrow} viewportRef={detailRef}>
        <Box p={flat ? 0 : narrow ? 'md' : 'lg'}>
          {firstLoad ? <PageLoader label='Loading modules…' /> : selected
            ? (
              <ModulePanel
                key={selected.name}
                module={selected}
                modules={all}
                onOpenModule={(name) => go(name)}
                section={section}
                onSection={(next) => go(selected.name, false, next)}
              />
            )
            : <EmptyState title='No module to show'>Pick a module in the list.</EmptyState>}
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
      {body}
    </Stack>
  );
}
