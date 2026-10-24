import { Alert, Anchor, Badge, Box, Chip, Group, Table, Text, Title } from '@mantine/core';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { IconAlertTriangle } from '@tabler/icons-react';
import { memo, useEffect, useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { type CommandReference as CommandEntry, type CommandSpec, useCommandReference, usePersistedState } from '@ein/ui/hooks';
import { HighlightedCode } from '../CodeEditor/HighlightedCode.tsx';
import { commandAnchor, commandRoute, DescriptionText, OwnerBadge, ReferenceIntro, useScrollToHash } from './reference.tsx';

/**
 * How a command is typed: `config-list` is `config list`, because `config` is a group that
 * dispatches to it. The longest group prefix wins, so a group inside a group reads right too.
 */
export const displayNames = (commands: readonly CommandEntry[]): Map<string, string> => {
  const groups = commands.filter((entry) => entry.spec.group).map((entry) => entry.name).sort((a, b) => b.length - a.length);
  return new Map(commands.map((entry) => {
    const group = groups.find((name) => entry.name.startsWith(`${name}-`));
    return [entry.name, group ? `${group} ${entry.name.slice(group.length + 1)}` : entry.name];
  }));
};

const flagName = (name: string): string => name.length === 1 ? `-${name}` : `--${name}`;

/** A flag as typed, coloured as a flag with what it takes dimmed: `--limit <number>`. */
const FlagCode = ({ name, type }: { name: string; type?: string }) => (
  <code className='mrx-code mrx-code-inline'>
    <span className='mrx-tok-flag'>{flagName(name)}</span>
    {type && type !== 'bool' && <span className='mrx-tok-meta'>{` <${type}>`}</span>}
  </code>
);

/** The one-line shape of a call: `search [options] <query>…`. */
const synopsis = (display: string, spec: CommandSpec): string => {
  const parts = [display];
  if (spec.flags?.length) parts.push('[options]');
  for (const arg of spec.args ?? []) parts.push(`<${arg.name}>${arg.variadic ? '…' : ''}`);
  return parts.join(' ');
};

export function EffectBadge({ effect }: { effect?: 'read' | 'write' }) {
  if (effect === 'read') return <Badge size='sm' radius='sm' variant='light' color='teal' tt='none'>reads</Badge>;
  if (effect === 'write') return <Badge size='sm' radius='sm' variant='light' color='orange' tt='none'>changes things</Badge>;
  return null;
}

const Flags = ({ spec }: { spec: CommandSpec }) => (
  <Table withRowBorders={false} verticalSpacing={4} horizontalSpacing='sm' layout='fixed'>
    <Table.Tbody>
      {spec.flags!.map((flag) => (
        <Table.Tr key={flag.name}>
          <Table.Td w={{ base: '40%', sm: 220 }} style={{ verticalAlign: 'top' }}>
            <FlagCode name={flag.name} type={flag.type} />
          </Table.Td>
          <Table.Td style={{ verticalAlign: 'top' }}>
            <Text size='sm'>
              <DescriptionText text={flag.description} />
              {flag.repeatable && <Text span ml={4} c='dimmed' size='sm'>May be given more than once.</Text>}
              {flag.writes && <Text span ml={4} c='orange' size='sm'>Makes the call change things.</Text>}
              {flag.dryRun && <Text span ml={4} c='teal' size='sm'>Changes nothing; reports what it would do.</Text>}
            </Text>
          </Table.Td>
        </Table.Tr>
      ))}
    </Table.Tbody>
  </Table>
);

const Args = ({ spec, groupOf }: { spec: CommandSpec; groupOf: string | undefined }) => (
  <Table withRowBorders={false} verticalSpacing={4} horizontalSpacing='sm' layout='fixed'>
    <Table.Tbody>
      {spec.args!.map((arg) => (
        <Table.Tr key={arg.name}>
          <Table.Td w={{ base: '40%', sm: 220 }} style={{ verticalAlign: 'top' }}>
            <HighlightedCode inline language='text' code={`<${arg.name}>${arg.variadic ? '…' : ''}`} />
          </Table.Td>
          <Table.Td style={{ verticalAlign: 'top' }}>
            <Text size='sm'>
              <DescriptionText text={arg.description} />
              {arg.type !== 'string' && arg.type !== 'subcommand' && <Text span ml={4} c='dimmed' size='sm'>({arg.type})</Text>}
              {arg.writes === true && <Text span ml={4} c='orange' size='sm'>Given, the call changes things.</Text>}
              {Array.isArray(arg.writes) && <Text span ml={4} c='orange' size='sm'>{arg.writes.join(', ')} change things.</Text>}
              {arg.type === 'subcommand' && groupOf && <Text span ml={4} c='dimmed' size='sm'>See the {groupOf} commands below.</Text>}
            </Text>
          </Table.Td>
        </Table.Tr>
      ))}
    </Table.Tbody>
  </Table>
);

type EntryProps = { entry: CommandEntry; display: string; subcommands: { name: string; display: string }[] };

/**
 * What `--help` says of a command, below its name: what it does, how it is called, its arguments
 * and options, its subcommands, examples, and what it answers in JSON mode. `describe: false` leaves
 * the description to whatever shows it already.
 */
export function CommandHelp({ entry, display, subcommands, describe = true }: EntryProps & { describe?: boolean }) {
  const { spec } = entry;
  return (
    <>
      {describe && spec.description && (
        <Text size='sm' mb='xs'>
          <DescriptionText text={spec.description} />
        </Text>
      )}
      <HighlightedCode code={synopsis(display, spec)} />
      {spec.args && spec.args.length > 0 && (
        <Box mb='xs'>
          <Text size='xs' fw={600} tt='uppercase' c='dimmed' mb={2}>Arguments</Text>
          <Args spec={spec} groupOf={spec.group ? display : undefined} />
        </Box>
      )}
      {spec.flags && spec.flags.length > 0 && (
        <Box mb='xs'>
          <Text size='xs' fw={600} tt='uppercase' c='dimmed' mb={2}>Options</Text>
          <Flags spec={spec} />
        </Box>
      )}
      {subcommands.length > 0 && (
        <Box mb='xs'>
          <Text size='xs' fw={600} tt='uppercase' c='dimmed' mb={4}>Subcommands</Text>
          <Group gap={6}>
            {subcommands.map((sub) => <Anchor key={sub.name} component={Link} to={commandRoute(sub.name)} ff='monospace' size='sm'>{sub.display}</Anchor>)}
          </Group>
        </Box>
      )}
      {spec.examples && spec.examples.length > 0 && (
        <Box mb='xs'>
          <Text size='xs' fw={600} tt='uppercase' c='dimmed' mb={2}>Examples</Text>
          <HighlightedCode code={spec.examples.join('\n')} />
        </Box>
      )}
      {spec.returns && (
        <Text size='sm' c='dimmed'>
          <Text span fw={600} size='sm' c='dimmed' mr={4}>In JSON mode:</Text>
          <DescriptionText text={spec.returns} />
        </Text>
      )}
    </>
  );
}

/** One command, as complete as its spec says. Memoised: the page holds a few hundred. */
const CommandEntryView = memo(function CommandEntryView({ entry, display, subcommands }: EntryProps) {
  const { spec } = entry;
  return (
    <Box
      id={commandAnchor(entry.name)}
      className='mrx-docs-target'
      py='md'
      px='xs'
      style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
    >
      <Group gap='xs' mb={6} wrap='wrap'>
        <Title order={3} ff='monospace' fz='lg'>
          <Anchor href={`#${commandAnchor(entry.name)}`} c='inherit' underline='never'>{display}</Anchor>
        </Title>
        {display !== entry.name && <Text c='dimmed' ff='monospace' size='sm'>{entry.name}</Text>}
        <OwnerBadge owner={entry.module} />
        <EffectBadge effect={spec.effect} />
        {spec.daemon && <Badge size='sm' radius='sm' variant='light' color='gray' tt='none'>service</Badge>}
        {spec.json === false && <Badge size='sm' radius='sm' variant='light' color='gray' tt='none'>text only</Badge>}
      </Group>
      <CommandHelp entry={entry} display={display} subcommands={subcommands} />
    </Box>
  );
});

/** The commands a group dispatches to, by the group's typed name (`config`), from `displayNames`. */
export const subcommandsByGroup = (commands: readonly CommandEntry[], names: Map<string, string>): Map<string, { name: string; display: string }[]> => {
  const byGroup = new Map<string, { name: string; display: string }[]>();
  for (const entry of commands) {
    const display = names.get(entry.name)!;
    if (display === entry.name) continue;
    const group = display.slice(0, display.lastIndexOf(' '));
    byGroup.set(group, [...(byGroup.get(group) ?? []), { name: entry.name, display }]);
  }
  return byGroup;
};

/**
 * Every command on the reader's PATH, from each command's own spec — what `--help` says, for all
 * of them at once. Filtered by module; found by the search in the header.
 */
export function CommandReference() {
  const { data: commands, loading, error } = useCommandReference();
  const [module, setModule] = usePersistedState<string>('docs.commands.module', 'all');

  const names = useMemo(() => displayNames(commands ?? []), [commands]);
  const modules = useMemo(() => [...new Set((commands ?? []).map((entry) => entry.module))].sort((a, b) => a === 'core' ? -1 : b === 'core' ? 1 : a.localeCompare(b)), [
    commands,
  ]);
  const shown = useMemo(
    () => (commands ?? []).filter((entry) => module === 'all' || entry.module === module).toSorted((a, b) => names.get(a.name)!.localeCompare(names.get(b.name)!)),
    [commands, module, names],
  );
  const subcommandsOf = useMemo(() => subcommandsByGroup(commands ?? [], names), [commands, names]);

  // A link to one command must find it, whatever module the list was left filtered to.
  const { hash } = useLocation();
  const targeted = hash.startsWith(`#${commandAnchor('')}`) ? decodeURIComponent(hash.slice(commandAnchor('').length + 1)) : '';
  useEffect(() => {
    if (!targeted || module === 'all') return;
    if (commands?.some((entry) => entry.name === targeted && entry.module !== module)) setModule('all');
  }, [targeted, commands, module, setModule]);

  useScrollToHash(Boolean(commands) && (!targeted || shown.some((entry) => entry.name === targeted)));

  return (
    <Box>
      <ReferenceIntro title='Commands'>
        Every command on your PATH — the built-in ones and those the installed modules add — as each describes itself. The same text is what{' '}
        <HighlightedCode inline code='<command> --help' /> prints. Search from the box above to find a command by what it does.
      </ReferenceIntro>

      {error && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} mb='md'>
          {error.message}
        </Alert>
      )}
      {loading && !commands && <PageLoader label='Asking every command on your PATH to describe itself. The first time takes a while; after that it is remembered.' />}

      {commands && (
        <>
          <Chip.Group multiple={false} value={module} onChange={(value) => setModule(value as string)}>
            <Group gap={6} mb='md'>
              <Chip value='all' size='xs'>All {commands.length}</Chip>
              {modules.map((name) => (
                <Chip key={name} value={name} size='xs'>
                  {name} {commands.filter((entry) => entry.module === name).length}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
          {shown.map((entry) => (
            <CommandEntryView
              key={entry.name}
              entry={entry}
              display={names.get(entry.name)!}
              subcommands={entry.spec.group ? subcommandsOf.get(names.get(entry.name)!) ?? [] : []}
            />
          ))}
        </>
      )}
    </Box>
  );
}
