import { Group, Paper, Skeleton, Stack, Text } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import type { ConfigEntry } from '@ein/api';
import { SaveBar, settingOf, SettingSource, useViewSave } from '../components/Settings/mod.ts';
import { DurationInput } from '../components/Settings/DurationInput.tsx';
import { useConfig } from '../hooks/useConfig.ts';
import { humanDuration } from '../lib/accounts.ts';

/** The settings this view sets, in the order it shows them, with what each is called here and what it does. */
const ROWS = [
  {
    key: 'CFG_SESSION_MAX_AGE_SEC',
    label: 'Browser sign-in',
    help: 'How long a browser stays signed in after it was last used: opening EiN or moving between its pages. Unused for longer, it asks to sign in again.',
  },
  {
    key: 'CFG_SESSION_EXPIRES_SEC',
    label: 'Idle session',
    help: "How long a browser's session lasts unused before it is cleared away. One holding an open terminal is kept whatever this says. A change applies to new sign-ins.",
  },
  {
    key: 'CFG_LINK_SESSION_EXPIRES_SEC',
    label: 'Share link',
    help:
      "How long a browser that opened a share link keeps it while unused, never past the link's own end. A screen showing a dashboard is rarely reloaded, so this is longer than a sign-in.",
  },
] as const;

type Key = typeof ROWS[number]['key'];
type Draft = Record<Key, string>;

/** A number of seconds in words, or the value itself when it is not one. */
const words = (value: string): string => humanDuration(Number(value)) || `${value} seconds`;

/** Why a draft cannot be saved, or nothing. */
const problemOf = (draft: Draft): string | undefined =>
  Object.values(draft).some((value) => !/^\d+$/.test(value) || Number(value) <= 0) ? 'Each needs a length of time.' : undefined;

/**
 * Sign-in, a settings view of core's (`ui.sign-in`, a `settings.views` panel): how long a browser
 * stays signed in unused (`CFG_SESSION_MAX_AGE_SEC`), how long a session lasts unused
 * (`CFG_SESSION_EXPIRES_SEC`) and how long a share link's browser keeps it
 * (`CFG_LINK_SESSION_EXPIRES_SEC`), each as a length of time, saved together, with what the
 * values in force come to in a sentence.
 */
export default function SignInView() {
  const config = useConfig('system');
  const save = useViewSave();
  const entries = ROWS.map((row) => settingOf(config.entries, row.key));
  const loaded = entries.every((entry): entry is ConfigEntry => entry !== undefined);
  const saved = useMemo<Draft | undefined>(
    () => (loaded ? Object.fromEntries(ROWS.map((row, at) => [row.key, entries[at]!.value])) as Draft : undefined),
    entries.map((entry) => entry?.value),
  );
  const [draft, setDraft] = useState<Draft | undefined>(saved);
  useEffect(() => setDraft(saved), [saved]);

  if (config.loading) return <Skeleton height={300} radius='md' />;
  if (!saved) return <Text c='dimmed'>{config.error?.message ?? 'The sign-in settings did not load.'}</Text>;
  if (!draft) return <Skeleton height={300} radius='md' />;

  const changed = ROWS.filter((row) => draft[row.key] !== saved[row.key]);
  const signedIn = Math.min(Number(saved.CFG_SESSION_MAX_AGE_SEC), Number(saved.CFG_SESSION_EXPIRES_SEC));

  return (
    <Stack gap='lg'>
      <Text size='sm'>
        Now a browser left unused for {words(String(signedIn))} asks to sign in again, and one that opened a share link keeps it for{' '}
        {words(saved.CFG_LINK_SESSION_EXPIRES_SEC)} unused.
      </Text>

      <Paper p='md' radius='md' withBorder>
        <Stack gap='md'>
          {ROWS.map((row, at) => (
            <Stack key={row.key} gap={4}>
              <Group justify='space-between' wrap='nowrap'>
                <Text fw={600} size='sm'>{row.label}</Text>
                <SettingSource entry={entries[at]!} />
              </Group>
              <Text size='xs' c='dimmed'>{row.help}</Text>
              <DurationInput
                // A new value in force starts the control again in the unit that fits it.
                key={saved[row.key]}
                value={draft[row.key]}
                disabled={save.busy}
                onChange={(value) => {
                  save.clear();
                  setDraft({ ...draft, [row.key]: value });
                }}
              />
            </Stack>
          ))}
        </Stack>
      </Paper>

      <SaveBar
        save={save}
        dirty={changed.length > 0}
        blocked={problemOf(draft)}
        onCancel={() => setDraft(saved)}
        onSave={() => save.run(() => config.saveAll(Object.fromEntries(changed.map((row) => [row.key, draft[row.key]]))))}
      />
    </Stack>
  );
}
