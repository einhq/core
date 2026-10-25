import { useDebouncedValue } from '@mantine/hooks';
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CommandFind } from '@ein/api';
import { type EntityCompleteKind, useEntityComplete } from '../../hooks/useMentionComplete.ts';
import { paramsFromFilters } from '../../lib/search-params.ts';
import { shq } from '../../lib/shquote.ts';
import { matchesText } from '../../lib/text-match.ts';
import { moduleRoutePaths, openRoute, searchableKinds } from '../../signals/module-ui.ts';
import { runNavAction, uiNav } from '../../signals/nav.ts';
import { execCommand } from '../../signals/shell-client.ts';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import { EntityThumb } from './EntityThumb.tsx';

/** One row of the finder: a search, a page, an entry's action, an entity, or a command's reference. */
type FinderItem = { id: string; group: string; label: string; detail?: string; icon: ReactNode; run: () => void };

/** What starts a query for commands rather than for the archive. */
export const COMMAND_PREFIX = '>';

/** How many commands a query lists, from the command index. */
const COMMANDS = 6;

export type Finder = {
  items: FinderItem[];
  /** Entities or commands are still being looked up. */
  loading: boolean;
  /** The query is for commands (`> …`). */
  commandMode: boolean;
  /** The words after `>` are too few to look commands up by. */
  commandTooShort: boolean;
  /** The row Enter runs; -1 while nothing is typed and no arrow has been pressed. */
  active: number;
  setActive: (index: number) => void;
  /** Arrows move between rows, Enter runs the active one. */
  onKeyDown: (event: KeyboardEvent) => void;
  /** The element holding the rows, so the active one is kept in view. */
  listRef: RefObject<HTMLDivElement | null>;
};

/**
 * The finder behind the top bar's search box and the Mod+K dialog: one list over what the app can
 * reach. With nothing typed it lists the sidebar's pages and the top bar's actions. Typed words
 * give a search first, so Enter takes them to the Search page unless an arrow chose another row,
 * then one of the media when a module draws the Media page, the pages and actions they match, and
 * the things of the kinds the Search page finds whose names match (`completion-entity`). A query
 * starting with `>` lists the commands that match it by meaning instead (`docs find`), each
 * opening its reference.
 *
 * `enabled` is whether the list is shown, so nothing is looked up for a closed one; `done` is
 * called before a row runs, for the host to close.
 */
export function useFinder(query: string, enabled: boolean, done: () => void): Finder {
  const navigate = useNavigate();
  const doneRef = useRef(done);
  doneRef.current = done;
  const listRef = useRef<HTMLDivElement>(null);

  const words = query.trim();
  const commandMode = words.startsWith(COMMAND_PREFIX);
  const commandWords = commandMode ? words.slice(COMMAND_PREFIX.length).trim() : '';
  const commandTooShort = commandMode && commandWords.length < 2;
  const [debouncedCommand] = useDebouncedValue(commandWords, 200);
  const [commands, setCommands] = useState<CommandFind['hits']>([]);
  const [findingCommands, setFindingCommands] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (!enabled || debouncedCommand.length < 2) {
      setCommands([]);
      return;
    }
    let current = true;
    setFindingCommands(true);
    execCommand<CommandFind>(`docs find ${shq(debouncedCommand)} --limit ${COMMANDS}`)
      .then((answer) => current && setCommands(answer?.hits ?? []))
      .catch(() => current && setCommands([]))
      .finally(() => current && setFindingCommands(false));
    return () => {
      current = false;
    };
  }, [enabled, debouncedCommand]);

  // The kinds the Search page finds are the ones worth going to by name.
  const kinds = searchableKinds.value;
  const entityKinds = useMemo(() => kinds.map((entry) => entry.kind as EntityCompleteKind), [kinds]);
  const entityGroup = kinds.map((entry, index) => index === 0 ? entry.label : entry.label.toLowerCase()).join(', ');
  const entityQuery = enabled && !commandMode && words ? words : undefined;
  const { hits: entities, loading: findingEntities } = useEntityComplete(entityQuery, entityKinds);
  const media = moduleRoutePaths.value.has('/media');

  const items = useMemo((): FinderItem[] => {
    const after = (run: () => void) => () => {
      doneRef.current();
      run();
    };

    if (commandMode) {
      if (commandTooShort) return [];
      return commands.map((hit) => ({
        id: `command:${hit.name}`,
        group: 'Commands',
        label: hit.name,
        detail: hit.description,
        icon: <TablerIcon name='terminal-2' size={18} />,
        run: after(() => navigate(`/docs/commands#cmd-${encodeURIComponent(hit.name)}`)),
      }));
    }

    const nav = uiNav.value;
    const pages: FinderItem[] = nav.sections.flatMap((section) =>
      section.items.map((link) => ({
        id: `page:${link.id}`,
        group: 'Go to',
        label: link.label,
        detail: section.label,
        icon: <TablerIcon name={link.icon} size={18} />,
        run: after(() => navigate(link.to)),
      }))
    );
    const actions: FinderItem[] = nav.topbar.flatMap((entry) => {
      const rows = entry.menu?.length ? entry.menu.map((row) => ({ ...row, title: `${entry.title}: ${row.title}` })) : [entry];
      return rows.flatMap((row) =>
        row.action
          ? [{
            id: `action:${row.id}`,
            group: 'Do',
            label: row.title,
            icon: <TablerIcon name={row.icon} size={18} />,
            run: after(() => void runNavAction(row.action!, { navigate })),
          }]
          : []
      );
    });
    if (!words) return [...pages, ...actions];

    const searches: FinderItem[] = [
      {
        id: 'search:all',
        group: 'Search',
        label: `Search for "${words}"`,
        icon: <TablerIcon name='search' size={18} />,
        run: after(() => navigate(`/search?${paramsFromFilters({ query: words })}`)),
      },
      ...(media
        ? [{
          id: 'search:media',
          group: 'Search',
          label: `Pictures of "${words}"`,
          icon: <TablerIcon name='photo-search' size={18} />,
          run: after(() => navigate(`/media?q=${encodeURIComponent(words)}`)),
        }]
        : []),
    ];
    const listed = [...pages, ...actions].filter((item) => matchesText([item.label, item.detail], words));
    const found: FinderItem[] = entities.map((hit) => ({
      id: `entity:${hit.path}`,
      group: entityGroup,
      label: hit.name,
      detail: hit.kind,
      icon: <EntityThumb hit={hit} />,
      run: after(() => {
        const route = openRoute(hit.type, hit.path);
        if (route) navigate(route);
      }),
    }));
    return [...searches, ...listed, ...found];
  }, [words, commandMode, commandTooShort, commands, entities, entityGroup, media, uiNav.value, navigate]);

  // Typed words start on their first row, the search; with nothing typed Enter does nothing until an arrow picks a row.
  useEffect(() => setActive(words ? 0 : -1), [words]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(items.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      items[active]?.run();
    }
  };

  return {
    items,
    loading: findingEntities || findingCommands,
    commandMode,
    commandTooShort,
    active,
    setActive,
    onKeyDown,
    listRef,
  };
}
