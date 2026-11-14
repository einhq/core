import { ActionIcon, Button, Group, Paper, PasswordInput, Skeleton, Stack, Text, TextInput } from '@mantine/core';
import { IconCircleCheck, IconPlugConnectedX, IconPlus, IconX } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import type { ModuleSearch } from '@ein/api';
import { SaveBar, settingOf, SettingSource, useViewSave } from '../components/Settings/mod.ts';
import { useCommand } from '../hooks/useCommand.ts';
import { useConfig } from '../hooks/useConfig.ts';

type Draft = { sources: string[]; tokens: string };

/** `CFG_MODULE_SOURCES` as its addresses, in order. */
const sourcesOf = (value: string): string[] => value.split(/[\s,]+/).filter(Boolean);

/** An organisation's address as `mod search` names it: `https://host/owner`, without a trailing `/`; nothing when it is not one. */
const canonical = (value: string): string | undefined => {
  try {
    const url = new URL(value.trim());
    const parts = url.pathname.split('/').filter(Boolean);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || parts.length !== 1 || url.search || url.hash || url.username) return undefined;
    return `${url.origin}/${parts[0]}`;
  } catch {
    return undefined;
  }
};

/** Why an address is no organisation's, or nothing when it is one or is still empty. */
const problemOf = (value: string): string | undefined =>
  value.trim() && !canonical(value) ? "An organisation's address: https://, its host, and the organisation, such as https://github.com/einhq." : undefined;

/** How one source answered `mod search`: the modules found in it, or why it was not read. */
function SourceState({ source, search }: { source: string; search: ModuleSearch }) {
  const failure = search.failed.find((each) => each.source === source);
  if (failure) {
    return (
      <Group gap='xs' wrap='nowrap' align='flex-start'>
        <IconPlugConnectedX size={18} color='var(--mantine-color-yellow-6)' style={{ flex: 'none' }} />
        <Text size='sm'>{source}: {failure.reason}</Text>
      </Group>
    );
  }
  const names = search.modules.filter((module) => module.source === source).map((module) => module.name);
  return (
    <Group gap='xs' wrap='nowrap' align='flex-start'>
      <IconCircleCheck size={18} color='var(--mantine-color-green-6)' style={{ flex: 'none' }} />
      <Text size='sm'>
        {source}: {names.length === 0 ? 'answers, with no module in it' : `${names.length} ${names.length === 1 ? 'module' : 'modules'}, ${names.join(', ')}`}
      </Text>
    </Group>
  );
}

/**
 * Module sources, a settings view of core's (`ui.module-sources`, a `settings.views` panel): the
 * organisations published modules are looked for in (`CFG_MODULE_SOURCES`), one address to a row
 * in the order they are asked, and the tokens for those that are not public
 * (`CFG_MODULE_SOURCES_KEY`), saved together; then what `mod search` found in each, or why it could
 * not read one.
 */
export default function ModuleSourcesView() {
  const config = useConfig('system');
  const search = useCommand<ModuleSearch>('mod search');
  const save = useViewSave();
  const sources = settingOf(config.entries, 'CFG_MODULE_SOURCES');
  const tokens = settingOf(config.entries, 'CFG_MODULE_SOURCES_KEY');

  const saved = useMemo<Draft | undefined>(() => (sources ? { sources: sourcesOf(sources.value), tokens: '' } : undefined), [sources?.value]);
  const [draft, setDraft] = useState<Draft | undefined>(saved);
  useEffect(() => setDraft(saved), [saved]);

  if (config.loading) return <Skeleton height={280} radius='md' />;
  if (!saved || !tokens) return <Text c='dimmed'>{config.error?.message ?? 'The module source settings did not load.'}</Text>;
  if (!draft) return <Skeleton height={280} radius='md' />;

  const change = (next: Partial<Draft>) => {
    save.clear();
    setDraft({ ...draft, ...next });
  };
  const setSource = (at: number, value: string) => change({ sources: draft.sources.map((each, index) => (index === at ? value : each)) });
  const listed = draft.sources.map((each) => each.trim()).filter(Boolean);
  const value = listed.map((each) => canonical(each) ?? each).join(' ');
  const dirty = value !== saved.sources.join(' ') || draft.tokens.trim() !== '';
  const blocked = listed.some((each) => problemOf(each)) ? 'Correct the address marked above.' : undefined;
  const tokensSet = tokens.source !== 'default';

  const onSave = async () => {
    const ok = await save.run(() =>
      config.saveAll({
        CFG_MODULE_SOURCES: value,
        ...(draft.tokens.trim() ? { CFG_MODULE_SOURCES_KEY: draft.tokens.trim() } : {}),
      })
    );
    if (ok) setDraft((current) => current && { ...current, tokens: '' });
    search.refetch();
  };
  const asked = saved.sources.map((each) => canonical(each)).filter((each): each is string => each !== undefined);

  return (
    <Stack gap='lg'>
      <Paper p='md' radius='md' withBorder>
        <Stack gap='sm'>
          <Group justify='space-between' wrap='nowrap'>
            <Text fw={600}>Where modules come from</Text>
            <SettingSource entry={sources!} />
          </Group>
          <Text size='sm' c='dimmed'>
            Organisations on GitHub, Forgejo or Gitea. Each repository named module-&lt;name&gt; in them is a module, offered under Settings → Modules. A module installed by
            name comes from the first that has it.
          </Text>
          {draft.sources.map((each, at) => (
            <Group key={at} gap='xs' wrap='nowrap' align='flex-start'>
              <TextInput
                aria-label={`Source ${at + 1}`}
                placeholder='https://github.com/einhq'
                value={each}
                error={problemOf(each)}
                disabled={save.busy}
                style={{ flex: 1, minWidth: 0 }}
                onChange={(event) => setSource(at, event.currentTarget.value)}
              />
              <ActionIcon
                variant='subtle'
                color='gray'
                size='lg'
                aria-label={`Remove source ${at + 1}`}
                disabled={save.busy}
                onClick={() => change({ sources: draft.sources.filter((_, index) => index !== at) })}
              >
                <IconX size={16} />
              </ActionIcon>
            </Group>
          ))}
          {draft.sources.length === 0 && <Text size='sm' c='dimmed'>None: a module is installed by its repository's address alone.</Text>}
          <Group>
            <Button variant='subtle' size='xs' leftSection={<IconPlus size={14} />} disabled={save.busy} onClick={() => change({ sources: [...draft.sources, ''] })}>
              Add a source
            </Button>
          </Group>
          <PasswordInput
            label={
              <Group gap='xs' component='span'>
                Tokens for private sources
                <SettingSource entry={tokens} />
              </Group>
            }
            description='An access token for each source that is not public, as host=token, separated by spaces: forge.example:3000=… github.com=…. Each is sent to its own host alone. What is typed here replaces every token set before.'
            placeholder={tokensSet ? 'Set — type new ones to replace them' : 'None'}
            autoComplete='new-password'
            value={draft.tokens}
            disabled={save.busy}
            onChange={(event) => change({ tokens: event.currentTarget.value })}
          />
        </Stack>
      </Paper>

      <SaveBar save={save} dirty={dirty} blocked={blocked} onCancel={() => setDraft(saved)} onSave={onSave} />

      <Paper p='md' radius='md' withBorder>
        <Stack gap='xs'>
          <Text fw={600}>Now</Text>
          {search.loading
            ? <Skeleton height={20} />
            : search.data
            ? asked.length > 0
              ? asked.map((source) => <SourceState key={source} source={source} search={search.data!} />)
              : <Text size='sm' c='dimmed'>No source is set, so no module is offered by name.</Text>
            : <Text size='sm' c='dimmed'>{search.error?.message ?? 'No answer.'}</Text>}
        </Stack>
      </Paper>
    </Stack>
  );
}
