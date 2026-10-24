/**
 * The pieces the user and group panels are built from: the scroll box a pane has beside the other,
 * a header, sections that say what they do, quiet notes, the confirmation after a change, and the
 * inline confirmations a risky change asks for.
 */

import { Alert, Box, Button, Group, Paper, Select, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconInfoCircle, IconTrash } from '@tabler/icons-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

/** `a name is required` → `A name is required`: a problem said under a field. */
export const asSentence = (text: string): string => text[0].toUpperCase() + text.slice(1);

/** The picture, the name, the ids under it — a line each when there are several — and the badges for its state. */
export function PanelHeader({ avatar, title, meta, badges }: { avatar: ReactNode; title: string; meta: string | string[]; badges?: ReactNode }) {
  return (
    <Group gap='md' wrap='nowrap' align='center'>
      {avatar}
      <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
        <Title order={3} lineClamp={2} style={{ overflowWrap: 'anywhere' }}>{title}</Title>
        {[meta].flat().map((line) => <Text key={line} size='sm' c='dimmed' truncate title={line}>{line}</Text>)}
        {badges && <Group gap={6}>{badges}</Group>}
      </Stack>
    </Group>
  );
}

type PanelSectionProps = {
  title: string;
  /** One line on what the section does. */
  lead?: ReactNode;
  /** Why the last change made here failed; dismissing it calls `onDismiss`. */
  error?: string | null;
  onDismiss?: () => void;
  children?: ReactNode;
};

/** One part of a panel: its heading and lead, its controls, and a change's failure at its foot. */
export function PanelSection({ title, lead, error, onDismiss, children }: PanelSectionProps) {
  return (
    <Stack gap='sm'>
      <Box>
        <Title order={5}>{title}</Title>
        {lead && <Text size='sm' c='dimmed'>{lead}</Text>}
      </Box>
      {children}
      {error && (
        <Alert color='red' p='xs' icon={<IconAlertTriangle size={16} />} withCloseButton closeButtonLabel='Dismiss' onClose={onDismiss}>
          {error}
        </Alert>
      )}
    </Stack>
  );
}

/** The quiet confirmation beside the button that made a change. */
export function Done({ children }: { children: string }) {
  return (
    <Group gap={4} c='teal' wrap='nowrap'>
      <IconCheck size={16} />
      <Text size='sm'>{children}</Text>
    </Group>
  );
}

/** A quiet line after an icon: what a group is for, when a change takes effect. `warn` makes the icon a yellow triangle. */
export function Note({ warn, children }: { warn?: boolean; children: ReactNode }) {
  const Icon = warn ? IconAlertTriangle : IconInfoCircle;
  return (
    <Group gap={6} wrap='nowrap' align='flex-start'>
      <Icon
        size={16}
        aria-hidden
        color={warn ? 'var(--mantine-color-yellow-filled)' : 'var(--mrx-text-secondary)'}
        style={{ flex: 'none', marginTop: 2 }}
      />
      <Text size='sm' c='dimmed'>{children}</Text>
    </Group>
  );
}

/**
 * Whether an inline confirmation is open, and the button that opens it. Cancelling hands the focus
 * back to that button, which comes back as the confirmation goes.
 */
export function useInlineConfirm() {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);

  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    opener.current?.focus();
  }, [open]);

  return {
    open,
    opener,
    show: () => setOpen(true),
    cancel: () => {
      refocus.current = true;
      setOpen(false);
    },
  };
}

type DeleteConfirmProps = {
  /** What the deletion does, ending where the heir is picked. */
  children: ReactNode;
  heirs: { value: string; label: string }[];
  heir: string | null;
  onHeir: (next: string) => void;
  /** The red button's words: `Delete anna`. */
  action: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A deletion spelled out where it was asked for, with the heir to what is owned picked there. It
 * takes the focus as it opens, on the heir's picker.
 */
export function DeleteConfirm({ children, heirs, heir, onHeir, action, busy, onConfirm, onCancel }: DeleteConfirmProps) {
  const textId = useId();
  const heirRef = useRef<HTMLInputElement>(null);
  useEffect(() => heirRef.current?.focus(), []);

  return (
    <Paper
      role='group'
      aria-labelledby={textId}
      p='md'
      radius='md'
      withBorder
      bg='color-mix(in srgb, var(--mantine-color-red-filled) 7%, var(--mrx-surface-raised))'
      style={{ borderColor: 'color-mix(in srgb, var(--mantine-color-red-filled) 55%, transparent)' }}
    >
      <Stack gap='sm'>
        <Text id={textId} size='sm'>{children}</Text>
        <Select
          ref={heirRef}
          aria-label='Who takes over'
          searchable
          maw={360}
          data={heirs}
          value={heir}
          allowDeselect={false}
          nothingFoundMessage='Nothing by that name'
          disabled={busy}
          onChange={(next) => next && onHeir(next)}
        />
        <Group gap='xs'>
          <Button color='red' leftSection={<IconTrash size={16} />} loading={busy} disabled={!heir} onClick={onConfirm}>{action}</Button>
          <Button variant='default' disabled={busy} onClick={onCancel}>Cancel</Button>
        </Group>
      </Stack>
    </Paper>
  );
}
