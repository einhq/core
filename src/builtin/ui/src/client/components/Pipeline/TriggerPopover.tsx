import { ActionIcon, Badge, Code, Divider, Group, HoverCard, ScrollArea, Stack, Text } from '@mantine/core';
import { IconBolt, IconCheck, IconFilter, IconFlag, IconPlayerSkipForward, IconVariable } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { PipelineTriggerSummary } from '@ein/api';

type Props = {
  triggers: PipelineTriggerSummary[];
};

/**
 * What starts a pipeline, behind an icon beside its name.
 *
 * Behind an icon so every row of the work table stays one line tall: it is read once per
 * pipeline, not once per glance. The guards are shown as well — they are the half that explains
 * a surprising count: a pipeline with nothing waiting is often one whose `skipIfExists` matches
 * every file, not one whose event never fires.
 *
 * Conditions are listed in the order the engine tests them, so reading down the card is
 * reading the decision.
 */
export function TriggerPopover({ triggers }: Props) {
  if (triggers.length === 0) return null;

  return (
    <HoverCard position='bottom-start' width={440} shadow='lg' withArrow openDelay={150} closeDelay={100}>
      <HoverCard.Target>
        {/* The row navigates on click; tapping the icon must open the card instead. */}
        <ActionIcon variant='subtle' color='gray' size='sm' aria-label='Triggers' onClick={(event) => event.stopPropagation()}>
          <IconBolt size={14} />
        </ActionIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown maw='calc(100vw - 32px)' onClick={(event) => event.stopPropagation()} style={{ cursor: 'default' }}>
        <Stack gap='sm'>
          {triggers.map((trigger, index) => (
            <Stack key={index} gap='sm'>
              {index > 0 && <Divider label='or' labelPosition='center' />}
              <TriggerCard trigger={trigger} />
            </Stack>
          ))}
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function TriggerCard({ trigger }: { trigger: PipelineTriggerSummary }) {
  return (
    <Stack gap={6}>
      <Group gap={6} wrap='wrap'>
        <Text size='xs' c='dimmed' tt='uppercase' fw={600}>{trigger.on ? 'On fact' : 'On node event'}</Text>
        {trigger.on
          ? trigger.on.map((name) => <Badge key={name} variant='light' size='sm' tt='none' ff='monospace'>{name}</Badge>)
          : <Badge variant='light' size='sm' tt='none' ff='monospace'>{trigger.event} {trigger.nodeType}</Badge>}
      </Group>

      {Object.entries(trigger.match ?? {}).map(([field, globs]) => (
        <Condition key={field} icon={<IconFilter size={14} />} color='blue'>
          Only when <FieldGlobs field={field} globs={globs} />
        </Condition>
      ))}

      {trigger.unless && (
        <Condition icon={<IconPlayerSkipForward size={14} />} color='orange'>
          Skip when {Object.entries(trigger.unless).map(([field, globs], i) => (
            <span key={field}>
              {i > 0 && ' and '}
              <FieldGlobs field={field} globs={globs} />
            </span>
          ))}
        </Condition>
      )}

      {trigger.allowDerived
        ? <Condition icon={<IconCheck size={14} />} color='blue'>Also derived files (renditions, versions)</Condition>
        : <Condition icon={<IconPlayerSkipForward size={14} />} color='gray'>Skip derived files (renditions, versions)</Condition>}

      {trigger.skipIfExists && (
        <Condition icon={<IconPlayerSkipForward size={14} />} color='orange'>
          Skip when <Code>{trigger.skipIfExists}</Code> exists
        </Condition>
      )}

      {trigger.skipIfAttr && (
        <Condition icon={<IconPlayerSkipForward size={14} />} color='orange'>
          Skip when the node already has <Code>{trigger.skipIfAttr}</Code>
        </Condition>
      )}

      {trigger.filter && (
        <Condition icon={<IconFilter size={14} />} color='blue'>
          Only when this script exits 0
          <Script source={trigger.filter} />
        </Condition>
      )}

      {trigger.skipIf && (
        <Condition icon={<IconPlayerSkipForward size={14} />} color='orange'>
          Skip when this script exits 0
          <Script source={trigger.skipIf} />
        </Condition>
      )}

      {trigger.vars && Object.keys(trigger.vars).length > 0 && (
        <Condition icon={<IconVariable size={14} />} color='grape'>
          Sets {Object.entries(trigger.vars).map(([name, value], i) => (
            <span key={name}>
              {i > 0 && ', '}
              <Code>{name}={value}</Code>
            </span>
          ))}
        </Condition>
      )}

      {trigger.priority !== undefined && (
        <Condition icon={<IconFlag size={14} />} color='grape'>
          Priority <Code>{trigger.priority}</Code> for instances it starts
        </Condition>
      )}
    </Stack>
  );
}

/** `field is glob`, or `field is one of glob, glob` for a list. */
function FieldGlobs({ field, globs }: { field: string; globs: string | string[] }) {
  return (
    <>
      <Code>{field}</Code> is {Array.isArray(globs) ? 'one of ' : ''}
      {(Array.isArray(globs) ? globs : [globs]).map((glob, i) => (
        <span key={glob}>
          {i > 0 && ', '}
          <Code>{glob}</Code>
        </span>
      ))}
    </>
  );
}

function Condition({ icon, color, children }: { icon: ReactNode; color: string; children: ReactNode }) {
  return (
    <Group gap={8} wrap='nowrap' align='flex-start'>
      <Text c={color} lh={1} mt={2} component='span'>{icon}</Text>
      <Text size='sm' component='div' style={{ flex: 1, minWidth: 0 }}>{children}</Text>
    </Group>
  );
}

/** The shell escape hatches can run to dozens of lines of commented `case`; cap their height. */
function Script({ source }: { source: string }) {
  return (
    <ScrollArea.Autosize mah={200} mt={4} type='auto'>
      <Code block fz='xs'>{source.trimEnd()}</Code>
    </ScrollArea.Autosize>
  );
}
