import { Anchor, Badge, Box, Group, SimpleGrid, Skeleton, Stack, Text, Title, Tooltip } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import type { ModuleEntry, SystemInfo } from '@ein/api';
import { DialogActions, RoutePanel, StatTile } from '@ein/ui/components';
import { useModuleReference, usePolledCommand, useSurface } from '@ein/ui/hooks';
import { formatUptime } from '@ein/ui/lib';
import { panelRoute, panelsOf } from '@ein/ui/signals';
import { Link } from 'react-router-dom';
import { HatField } from '../components/EntityDetail/HatField.tsx';
import { HatIdenticon } from '../components/Identity/HatIdenticon.tsx';
import { EinMark, MARK_COLORS } from '../components/Layout/EinMark.tsx';

/** As wide as the dialog is, or the page: room for the modules beside the rest (`.mrx-about-body`). */
export const ABOUT_WIDTH = 1040;

/** `11 Oct`, with the year when it is not this one. */
const day = (iso: string) => {
  const date = new Date(iso);
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year });
};

/** `9 Oct, 14:02`. */
const moment = (at: number) => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** The mark and the name, for the hat field in all of the mark's colours: the dialog's hero band (the route's `handle`), the page's own. */
export function AboutHero() {
  return (
    <Group gap='md' wrap='nowrap'>
      <EinMark size={60} />
      <Box>
        <Title order={2} c='white' fz={38} lh={1} style={{ fontFamily: '"Mochiy Pop One", sans-serif' }}>EiN</Title>
        <Text c='gray.3' size='sm' mt={6}>Everything is a Node</Text>
      </Box>
    </Group>
  );
}

/** One installed module: its hat in `color`, name, version and what it does, and the module API it is written against. */
function ModuleRow({ module, color }: { module: ModuleEntry; color: string }) {
  return (
    <Group wrap='nowrap' gap='sm' align='flex-start' py={6}>
      <Box
        className='mrx-about-module-hat'
        w={44}
        h={44}
        style={{ flex: 'none', borderRadius: 'var(--mantine-radius-md)', background: `color-mix(in srgb, ${color} 14%, var(--mrx-surface-raised))` }}
      >
        <HatIdenticon seed={`module:${module.name}`} label={module.name} color={color} />
      </Box>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Group gap={8} wrap='nowrap'>
          <Anchor component={Link} to={`/docs/modules/${module.name}`} fw={600} size='sm' c='var(--mrx-text-primary)'>
            {module.name}
          </Anchor>
          {module.version && <Text size='xs' c='dimmed' ff='monospace'>{module.version}</Text>}
          {module.setup && !module.setup.ok && <Badge size='xs' variant='light' color='red' tt='none'>setup failed</Badge>}
        </Group>
        {module.description && <Text size='xs' c='dimmed' lineClamp={2}>{module.description}</Text>}
      </Box>
      {module.coreApi && (
        <Tooltip label='The module API it is written against' withArrow>
          <Text size='xs' c='dimmed' ff='monospace' style={{ flex: 'none' }}>API {module.coreApi}</Text>
        </Tooltip>
      )}
    </Group>
  );
}

/** One fact about the instance and its label. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Group gap={6} wrap='nowrap'>
      <Text size='xs' c='dimmed'>{label}</Text>
      <Text size='xs' ff='monospace'>{value}</Text>
    </Group>
  );
}

/**
 * What EiN is: core's version and commit, the module API, how long it
 * has been up, every installed module, and the services it uses — each an `about.services` panel,
 * drawn by the module that talks to it (ems's media service, the assistant's language model).
 * Built from `system-info` and `mod list`. The profile menu opens it in the dialog, wide enough
 * for the modules to stand in a column of their own beside the rest.
 */
export default function AboutPage() {
  useSignals();
  const surface = useSurface();
  const { data: info } = usePolledCommand<SystemInfo>('system-info');
  const { data: modules } = useModuleReference({ fresh: true });
  const panels = panelsOf('about.services');

  const added = modules?.length;

  const inDialog = surface.kind === 'dialog';
  const facts = info && (
    <Group gap='lg' wrap='wrap'>
      {info.database && <Fact label='PostgreSQL' value={info.database.split(' ')[0]} />}
      <Fact label='Deno' value={info.denoVersion} />
    </Group>
  );

  const body = (
    <Box className='mrx-about-body' data-in-dialog={inDialog || undefined} {...(inDialog ? {} : { px: { base: 'md', sm: 'xl' }, py: { base: 'md', sm: 'xl', md: 'lg' } })}>
      <Stack gap='xs' maw='68ch' style={{ gridArea: 'intro' }}>
        <Text size='sm'>
          EiN is a modular system where any data can be stored as a node.
        </Text>
        <Text size='sm' c='dimmed'>
          At its centre is a small core: a virtual file system that keeps every node in one tree, a shell whose commands serve both the terminal and the API, pipelines that
          run commands in the background as nodes change, and this interface. Modules build on the core's versioned module API to add functionality for different uses.
        </Text>
      </Stack>

      {info
        ? (
          <SimpleGrid cols={3} spacing={{ base: 'xs', sm: 'sm' }} style={{ gridArea: 'tiles' }}>
            <StatTile
              label='Core'
              value={info.version}
              hint={info.build ? `${info.build.commit}, ${day(info.build.date)}` : undefined}
              accent={MARK_COLORS[0]}
              tooltip={info.build ? `Built from commit ${info.build.commit} of ${new Date(info.build.date).toLocaleString()}` : undefined}
            />
            <StatTile
              label='Module API'
              value={info.api}
              hint={added === undefined ? undefined : `${added} ${added === 1 ? 'module builds' : 'modules build'} on it`}
              accent={MARK_COLORS[2]}
            />
            <StatTile label='Up' value={formatUptime(info.uptimeMs)} hint={`since ${moment(Date.now() - info.uptimeMs)}`} accent={MARK_COLORS[3]} />
          </SimpleGrid>
        )
        : (
          <SimpleGrid cols={3} spacing={{ base: 'xs', sm: 'sm' }} style={{ gridArea: 'tiles' }}>
            {[0, 1, 2].map((n) => <Skeleton key={n} height={86} radius='md' />)}
          </SimpleGrid>
        )}

      <Stack gap={4} style={{ gridArea: 'modules' }}>
        <Group justify='space-between' align='baseline'>
          <Title order={4}>Modules</Title>
          {modules && <Text size='xs' c='dimmed'>{modules.length} installed</Text>}
        </Group>
        {modules
          ? modules.map((module, i) => <ModuleRow key={module.name} module={module} color={MARK_COLORS[i % MARK_COLORS.length]} />)
          : [0, 1, 2].map((n) => <Skeleton key={n} height={44} my={6} radius='md' />)}
      </Stack>

      {panels.length > 0 && (
        <Stack gap='xs' style={{ gridArea: 'services' }}>
          <Title order={4}>Services</Title>
          <SimpleGrid cols={{ base: 1, xs: 2 }} spacing='sm'>
            {panels.map((panel) => <RoutePanel key={panel.id} path={panelRoute(panel)} />)}
          </SimpleGrid>
        </Stack>
      )}

      {facts && !inDialog && <Box pt='sm' style={{ gridArea: 'facts', borderTop: '1px solid var(--mrx-hairline)' }}>{facts}</Box>}
    </Box>
  );

  if (inDialog) {
    return (
      <>
        {body}
        <DialogActions hint={facts} />
      </>
    );
  }
  return (
    <Box bg='var(--mrx-surface-base)' maw={ABOUT_WIDTH} mx='auto' style={{ borderRadius: 'var(--mantine-radius-md)', overflow: 'hidden' }}>
      <Box className='mrx-pattern' data-pattern='mixed' mih={{ base: 168, md: 136 }} p={{ base: 'md', sm: 'xl' }} display='flex' style={{ alignItems: 'flex-end' }}>
        <HatField pattern='mixed' />
        <AboutHero />
      </Box>
      {body}
    </Box>
  );
}
