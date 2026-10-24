import { Table, Text } from '@mantine/core';
import { useMemo, useState } from 'react';
import { usePhone } from '../../../hooks/usePhone.ts';
import type { CommandReference } from '../../../hooks/useReference.ts';
import { CommandHelp, displayNames, EffectBadge, subcommandsByGroup } from '../../Docs/CommandReference.tsx';
import { ExpandRow } from './ExpandRow.tsx';

type ModuleCommandsProps = {
  /** Every command on the reader's PATH, for how each is typed. */
  commands: CommandReference[];
  /** The module whose commands are listed. */
  module: string;
};

/**
 * A module's commands, sorted as they are typed: each row opens to the command's whole help, any
 * number at once. On a phone the row leaves its description to the help.
 */
export function ModuleCommands({ commands, module }: ModuleCommandsProps) {
  const names = useMemo(() => displayNames(commands), [commands]);
  const subcommands = useMemo(() => subcommandsByGroup(commands, names), [commands, names]);
  const own = commands.filter((entry) => entry.module === module).toSorted((a, b) => names.get(a.name)!.localeCompare(names.get(b.name)!));
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const phone = usePhone();

  if (own.length === 0) return <Text size='sm' c='dimmed'>It adds no commands.</Text>;

  const toggle = (name: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  return (
    <Table verticalSpacing='xs' highlightOnHover className='mrx-module-table'>
      <Table.Thead>
        <Table.Tr>
          <Table.Th w={36} pr={0} />
          <Table.Th>Command</Table.Th>
          <Table.Th>Effect</Table.Th>
          {!phone && <Table.Th>What it does</Table.Th>}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {own.map((entry) => {
          const display = names.get(entry.name)!;
          return (
            <ExpandRow
              key={entry.name}
              open={open.has(entry.name)}
              onToggle={() => toggle(entry.name)}
              label={`Help for ${display}`}
              columns={phone ? 3 : 4}
              cells={
                <>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>
                    <Text size='sm' ff='monospace'>{display}</Text>
                  </Table.Td>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>
                    <EffectBadge effect={entry.spec.effect} />
                  </Table.Td>
                  {!phone && (
                    <Table.Td>
                      <Text size='sm' c='dimmed' lineClamp={open.has(entry.name) ? undefined : 1}>{entry.spec.description}</Text>
                    </Table.Td>
                  )}
                </>
              }
            >
              <CommandHelp entry={entry} display={display} subcommands={subcommands.get(display) ?? []} describe={phone} />
            </ExpandRow>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}
