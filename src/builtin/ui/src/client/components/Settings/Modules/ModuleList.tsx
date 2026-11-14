import { Badge, Group, Switch, Text } from '@mantine/core';
import { IconCircleArrowUp } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { ModuleEntry } from '@ein/api';
import { matchesText } from '../../../lib/text-match.ts';
import { ModuleAvatar } from '../../Identity/ModuleAvatar.tsx';
import { ListFrame, ListRow } from '../ListDetail.tsx';

/**
 * Whether a module works. It is installed when its directory is under `/usr/modules`; it works
 * once `mod setup` has put its commands on PATH and started its services, and boot carries on past
 * a module whose setup fails.
 */
type ModuleState = 'failed' | 'not set up' | 'active';

export const moduleState = (module: ModuleEntry): ModuleState => !module.setup ? 'not set up' : module.setup.ok ? 'active' : 'failed';

export const STATE_COLOR: Record<ModuleState, string> = { failed: 'red', 'not set up': 'yellow', active: 'teal' };
export const STATE_LABEL: Record<ModuleState, string> = { failed: 'Setup failed', 'not set up': 'Not set up', active: 'Active' };

const RANK: Record<ModuleState, number> = { failed: 0, 'not set up': 1, active: 2 };

/** The order the list is in: a module that does not work first, since it is the one to look at, then by name. */
export const byState = (a: ModuleEntry, b: ModuleEntry): number => RANK[moduleState(a)] - RANK[moduleState(b)] || a.name.localeCompare(b.name);

/** Its state for one that does not work; its version for one that does, after a mark when there is a newer one. */
function Aside({ module, update }: { module: ModuleEntry; update: boolean }) {
  const state = moduleState(module);
  if (state !== 'active') {
    return <Badge size='sm' variant='dot' color={STATE_COLOR[state]} tt='none' style={{ flex: 'none' }}>{STATE_LABEL[state]}</Badge>;
  }
  return (
    <Group gap={4} wrap='nowrap' style={{ flex: 'none' }}>
      {update && <IconCircleArrowUp size={14} color='var(--mantine-primary-color-filled)' aria-label='A newer version can be installed' />}
      {module.version && <Text size='xs' c='dimmed' ff='monospace'>{module.version}</Text>}
    </Group>
  );
}

type ModuleListProps = {
  /** In display order. */
  modules: ModuleEntry[];
  /** The name of the module open beside the list. */
  selected?: string;
  onSelect: (name: string) => void;
  /** Whether a newer version of the module can be installed; absent where nobody may update. */
  hasUpdate?: (module: ModuleEntry) => boolean;
  filter: string;
  onFilter: (next: string) => void;
  loading: boolean;
  /** Beside the filter: the button that opens the panel that installs a module. */
  action?: ReactNode;
  /** Beside the open module: the rows scroll between the filter and the footer. */
  scrolls: boolean;
  activeOnly: boolean;
  onActiveOnly: (next: boolean) => void;
};

/**
 * The installed modules, narrowed by the filter, each opening its panel: its description under its
 * name, and at its right its version, marked when a newer one can be installed, or a badge when it
 * does not work. The switch at the foot leaves out the ones that do not; `action`, beside the
 * filter, opens the panel that installs one.
 */
export function ModuleList({ modules, selected, onSelect, hasUpdate, filter, onFilter, loading, action, scrolls, activeOnly, onActiveOnly }: ModuleListProps) {
  const shown = modules.filter((module) => matchesText([module.name, module.description], filter));
  return (
    <ListFrame
      what='modules'
      filter={filter}
      onFilter={onFilter}
      loading={loading}
      action={action}
      scrolls={scrolls}
      rows={shown.map((module) => (
        <ListRow
          key={module.name}
          selected={module.name === selected}
          onClick={() => onSelect(module.name)}
          avatar={<ModuleAvatar name={module.name} size={36} />}
          title={module.name}
          subtitle={module.description ?? ''}
          aside={<Aside module={module} update={hasUpdate?.(module) === true} />}
        />
      ))}
      footer={
        <Switch
          size='sm'
          label='Show only active modules'
          checked={activeOnly}
          onChange={(event) => onActiveOnly(event.currentTarget.checked)}
        />
      }
    />
  );
}
