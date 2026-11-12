import { ActionIcon, Alert, Button, Group, Menu, Select, Stack, Text, TextInput, ThemeIcon, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconChevronDown, IconCopy, IconDeviceTv, IconLink, IconTrash } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import type { ShareInfo, ShareLink } from '@ein/api';
import { copyText } from '../../lib/clipboard.ts';
import { expiryText, LINK_EXPIRIES, openedText, shareLinkUrl } from '../../lib/share-link.ts';
import type { LinkExpiry } from '../../hooks/useShare.ts';
import { notify } from '../../signals/notify.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One link: its address, which a click copies, when it stops working, how often it was opened, and
 * deleting it.
 */
function LinkRow({ link, editable, busy, pending, onExpiry, onRemove }: {
  link: ShareLink;
  editable: boolean;
  /** Something in the section is being done; `pending`, what is being done to this link. */
  busy: boolean;
  pending?: 'remove' | 'expiry';
  onExpiry: (expiry: LinkExpiry) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const url = link.token ? shareLinkUrl(globalThis.location.origin, link.token) : undefined;

  const copy = async () => {
    if (!url) return;
    if (!(await copyText(url, input.current))) {
      notify({ message: 'The browser would not copy the link: it is selected for you to copy.', color: 'yellow' });
      return;
    }
    notify({ message: 'Link copied to clipboard' });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const shownAs = link.as && (link.as.name ?? `user ${link.as.uid}`);

  return (
    <Group gap='sm' wrap='nowrap' align='flex-start'>
      <ThemeIcon size={32} radius='xl' variant='light' color={link.as?.refusal ? 'red' : 'teal'} style={{ flex: 'none' }}>
        {link.as ? <IconDeviceTv size={18} /> : <IconLink size={18} />}
      </ThemeIcon>
      <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text size='sm'>{shownAs ? `Shows it as ${shownAs} sees it` : 'Anyone with the link can view'}</Text>
          {link.as?.refusal
            ? <Text size='xs' c='red'>Opens nothing: {link.as.refusal}</Text>
            : <Text size='xs' c='dimmed'>{shownAs ? 'No sign-in needed, and nothing can be changed through it' : 'No account or sign-in needed'}</Text>}
        </Stack>

        {url && (
          <TextInput
            ref={input}
            size='xs'
            readOnly
            value={url}
            onClick={copy}
            aria-label='The link; click to copy it'
            rightSectionPointerEvents='all'
            rightSection={
              <Tooltip label={copied ? 'Copied' : 'Copy link'} withArrow>
                <ActionIcon variant='subtle' color={copied ? 'teal' : 'gray'} size='sm' onClick={copy} aria-label='Copy link'>
                  {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                </ActionIcon>
              </Tooltip>
            }
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', cursor: 'pointer' } }}
          />
        )}

        <Group gap='xs' justify='space-between' wrap='nowrap'>
          <Group gap={4} wrap='wrap' style={{ minWidth: 0 }}>
            {editable
              ? (
                <Menu position='bottom-start' shadow='md' withinPortal>
                  <Menu.Target>
                    <Button
                      variant='subtle'
                      color='gray'
                      size='compact-xs'
                      rightSection={<IconChevronDown size={12} />}
                      loading={pending === 'expiry'}
                      disabled={busy && pending !== 'expiry'}
                    >
                      {expiryText(link.expiresAt)}
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Label>Works for</Menu.Label>
                    {LINK_EXPIRIES.map((choice) => (
                      <Menu.Item key={choice.label} onClick={() => onExpiry(choice.days === null ? null : Date.now() + choice.days * DAY_MS)}>
                        {choice.label}
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
              )
              : <Text size='xs' c='dimmed'>{expiryText(link.expiresAt)}</Text>}
            <Text size='xs' c='dimmed'>· {openedText(link.opened, link.lastOpenedAt)}</Text>
          </Group>
          {editable && (
            <Button
              variant='subtle'
              color='red'
              size='compact-xs'
              leftSection={<IconTrash size={12} />}
              onClick={onRemove}
              loading={pending === 'remove'}
              disabled={busy && pending !== 'remove'}
              style={{ flex: 'none' }}
            >
              Delete link
            </Button>
          )}
        </Group>
      </Stack>
    </Group>
  );
}

type LinkSectionProps = {
  links: ShareLink[];
  editable: boolean;
  /** What the node is called in a sentence: `album`. */
  noun: string;
  /** Nodes inside it that keep their own sharing, which no link of its opens. */
  exceptions: number;
  /**
   * What a new link shows: the node alone, or the node as an account sees it (a display link),
   * which the person sharing picks from `accounts`.
   */
  shows: 'node' | 'account';
  accounts: ShareInfo['displayAccounts'];
  onCreate: (expiry?: LinkExpiry, as?: string) => Promise<void>;
  onExpiry: (id: string, expiry: LinkExpiry) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
};

/**
 * Making a display link: which account the screen shows the node as, for how long, and what that
 * means — whoever holds the link reads what the account reads.
 */
function NewDisplayLink({ noun, accounts, busy, onCreate }: {
  noun: string;
  accounts: ShareInfo['displayAccounts'];
  busy: boolean;
  onCreate: (expiry: LinkExpiry, as: string) => void;
}) {
  // An account made for screens before one's own.
  const [as, setAs] = useState<string | null>(() => (accounts.find((account) => !account.you) ?? accounts[0])?.username ?? null);
  const [days, setDays] = useState<string>('none');
  const chosen = accounts.find((account) => account.username === as);
  const name = chosen ? chosen.title ?? chosen.username : '';

  if (accounts.length === 0) {
    return (
      <Group gap='sm' wrap='nowrap' align='flex-start'>
        <ThemeIcon size={32} radius='xl' variant='light' color='gray' style={{ flex: 'none' }}>
          <IconDeviceTv size={18} />
        </ThemeIcon>
        <Text size='sm' c='dimmed'>
          A screen shows the {noun}{' '}
          as an account sees it. An administrator makes one for screens: an account in the groups whose things it should show, out of the Users group, and not an
          administrator.
        </Text>
      </Group>
    );
  }

  return (
    <Stack gap='xs'>
      <Group gap='sm' wrap='nowrap' align='flex-start'>
        <ThemeIcon size={32} radius='xl' variant='light' color='gray' style={{ flex: 'none' }}>
          <IconDeviceTv size={18} />
        </ThemeIcon>
        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
          <Text size='sm'>Show it on a screen that never signs in</Text>
          <Text size='xs' c='dimmed'>
            Anyone with the link sees the {noun}, and everything else {name || 'the account'} can read, as {name || 'it'}{' '}
            sees it, without signing in. Nothing can be changed through it.
          </Text>
        </Stack>
      </Group>
      <Group gap='xs' align='flex-end' wrap='wrap' pl={44}>
        <Select
          size='xs'
          label='Shows it as'
          data={accounts.map((account) => ({ value: account.username, label: `${account.title ?? account.username}${account.you ? ' (you)' : ''}` }))}
          value={as}
          onChange={setAs}
          allowDeselect={false}
          w={200}
        />
        <Select
          size='xs'
          label='Works for'
          data={LINK_EXPIRIES.map((choice) => ({ value: choice.days === null ? 'none' : String(choice.days), label: choice.label }))}
          value={days}
          onChange={(value) => setDays(value ?? 'none')}
          allowDeselect={false}
          w={140}
        />
        <Button variant='light' size='xs' loading={busy} disabled={!as} onClick={() => as && onCreate(days === 'none' ? null : Date.now() + Number(days) * DAY_MS, as)}>
          Create link
        </Button>
      </Group>
      {chosen?.you && (
        <Alert color='yellow' icon={<IconAlertTriangle size={16} />} ml={44} p='xs'>
          <Text size='xs'>Anyone with the link can read everything you can read in EiN. An account made for screens is safer.</Text>
        </Alert>
      )}
      {chosen && !chosen.you && chosen.everyone && (
        <Text size='xs' c='dimmed' ml={44}>
          {name}{' '}
          is in the Users group, so the link also reads everything shared with everyone with an account. An administrator can untick Users on the account in Settings →
          Accounts.
        </Text>
      )}
    </Stack>
  );
}

/**
 * Sharing by a link that opens the node without signing in. Unlike the people above it, whatever is
 * done here happens at once: a link copied before Save would otherwise open nothing.
 */
export function LinkSection({ links, editable, noun, exceptions, shows, accounts, onCreate, onExpiry, onRemove }: LinkSectionProps) {
  // What is being done, so its own button shows it: `create`, or `remove:` or `expiry:` and a link's id.
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (what: string, action: () => Promise<void>) => {
    setBusy(what);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };

  if (links.length === 0) {
    if (!editable) return <Text size='sm' c='dimmed'>No link opens this {noun}.</Text>;
    if (shows === 'account') {
      return <NewDisplayLink noun={noun} accounts={accounts} busy={busy === 'create'} onCreate={(expiry, as) => run('create', () => onCreate(expiry, as))} />;
    }
    return (
      <Group gap='sm' wrap='nowrap'>
        <ThemeIcon size={32} radius='xl' variant='light' color='gray' style={{ flex: 'none' }}>
          <IconLink size={18} />
        </ThemeIcon>
        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
          <Text size='sm'>Send a link to someone without an account</Text>
          <Text size='xs' c='dimmed'>Anyone with the link can view the {noun}. It stops working after 30 days, unless you change that.</Text>
        </Stack>
        <Button variant='light' size='compact-sm' loading={busy === 'create'} onClick={() => run('create', () => onCreate())} style={{ flex: 'none' }}>
          Create link
        </Button>
      </Group>
    );
  }

  return (
    <Stack gap='sm'>
      {links.map((link) => (
        <LinkRow
          key={link.id}
          link={link}
          editable={editable}
          busy={busy !== null}
          pending={busy === `remove:${link.id}` ? 'remove' : busy === `expiry:${link.id}` ? 'expiry' : undefined}
          onExpiry={(expiry) => run(`expiry:${link.id}`, () => onExpiry(link.id, expiry))}
          onRemove={() => run(`remove:${link.id}`, () => onRemove(link.id))}
        />
      ))}
      {exceptions > 0 && <Text size='xs' c='dimmed'>The link does not open what keeps its own sharing, listed below.</Text>}
    </Stack>
  );
}
