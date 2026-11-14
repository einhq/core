import { Anchor, Group, Paper, SegmentedControl, Skeleton, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SystemInfo } from '@ein/api';
import { LocaleSelect, SaveBar, settingOf, SettingSource, useViewSave } from '../components/Settings/mod.ts';
import { useCommand } from '../hooks/useCommand.ts';
import { useConfig } from '../hooks/useConfig.ts';

/** A language's own name in English: `Swedish` for `sv`. */
const languageName = (code: string): string => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** The time now as a zone's clock shows it, in `locale`. */
const clockIn = (zone: string, locale: string): string => {
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: 'numeric', timeZone: zone, timeZoneName: 'short' }).format(new Date());
  } catch {
    return '';
  }
};

/**
 * Language and time, a settings view of core's (`ui.language`, a `settings.views` panel): the
 * archive's language (`CFG_LANGUAGE`) and how dates and times are written (`CFG_TIME_LOCALE`),
 * saved together, and the time zone the deployment set, which is not a setting.
 */
export default function LanguageView() {
  const config = useConfig('system');
  const { data: info } = useCommand<SystemInfo>('system-info');
  const language = settingOf(config.entries, 'CFG_LANGUAGE');
  const locale = settingOf(config.entries, 'CFG_TIME_LOCALE');
  const [draft, setDraft] = useState({ language: '', locale: '' });
  const save = useViewSave();

  useEffect(() => {
    if (language && locale) setDraft({ language: language.value, locale: locale.value });
  }, [language?.value, locale?.value]);

  if (config.loading) return <Skeleton height={240} radius='md' />;
  if (!language || !locale) return <Text c='dimmed'>{config.error?.message ?? 'The language settings did not load.'}</Text>;

  const dirty = draft.language !== language.value || draft.locale !== locale.value;
  const change = (next: Partial<typeof draft>) => {
    save.clear();
    setDraft((current) => ({ ...current, ...next }));
  };

  return (
    <Stack gap='lg'>
      <Paper p='md' radius='md' withBorder>
        <Stack gap='xs'>
          <Group justify='space-between' wrap='nowrap'>
            <Text fw={600}>{language.label}</Text>
            <SettingSource entry={language} />
          </Group>
          <Text size='sm' c='dimmed'>{language.description}</Text>
          <SegmentedControl
            data={(language.choices ?? []).map((code) => ({ value: code, label: languageName(code) }))}
            value={draft.language}
            disabled={save.busy}
            onChange={(value) => change({ language: value })}
            style={{ alignSelf: 'flex-start' }}
          />
        </Stack>
      </Paper>

      <Paper p='md' radius='md' withBorder>
        <Stack gap='xs'>
          <Group justify='space-between' wrap='nowrap'>
            <Text fw={600}>{locale.label}</Text>
            <SettingSource entry={locale} />
          </Group>
          <Text size='sm' c='dimmed'>
            How every page writes dates and times, for everyone who has not chosen their own under{' '}
            <Anchor component={Link} to='/profile?tab=preferences' size='sm'>Profile → Preferences</Anchor>.
          </Text>
          <LocaleSelect value={draft.locale} disabled={save.busy} onChange={(value) => change({ locale: value })} />
        </Stack>
      </Paper>

      <Paper p='md' radius='md' withBorder>
        <Stack gap='xs'>
          <Text fw={600}>Time zone</Text>
          {info
            ? (
              <Text size='sm'>
                <Text span ff='monospace'>{info.timeZone}</Text>, where it is {clockIn(info.timeZone, draft.locale || locale.value)} now
              </Text>
            )
            : <Skeleton height={20} width={240} />}
          <Text size='sm' c='dimmed'>
            The zone the archive is shown and counted in, such as which year a photo taken late on New Year's Eve belongs to. The installation sets it, as TZ in its .env; it
            is not a setting here.
          </Text>
        </Stack>
      </Paper>

      <SaveBar
        save={save}
        dirty={dirty}
        onCancel={() => setDraft({ language: language.value, locale: locale.value })}
        onSave={() =>
          save.run(() =>
            config.saveAll({
              ...(draft.language !== language.value ? { CFG_LANGUAGE: draft.language } : {}),
              ...(draft.locale !== locale.value ? { CFG_TIME_LOCALE: draft.locale } : {}),
            })
          )}
      />
    </Stack>
  );
}
