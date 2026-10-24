import { ActionIcon, Button, Group, Menu, Stack, Text, TextInput, ThemeIcon, Tooltip } from '@mantine/core';
import { IconCheck, IconChevronDown, IconCopy, IconLink, IconTrash } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import type { ShareLink } from '@ein/api';
import { expiryText, LINK_EXPIRIES, openedText, shareLinkUrl } from '../../lib/share-link.ts';
import type { LinkExpiry } from '../../hooks/useShare.ts';
import { notify } from '../../signals/notify.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Put `text` on the clipboard. The Clipboard API exists only on a secure page, and EiN is often
 * reached over plain HTTP on the home network: there the shown link is selected and copied the
 * older way, which still works, and is left selected for Ctrl+C when even that is refused.
 */
async function copyText(text: string, input: HTMLInputElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused: fall through to the selection.
  }
  input?.focus();
  input?.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

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

  return (
    <Group gap='sm' wrap='nowrap' align='flex-start'>
      <ThemeIcon size={32} radius='xl' variant='light' color='teal' style={{ flex: 'none' }}>
        <IconLink size={18} />
      </ThemeIcon>
      <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text size='sm'>Anyone with the link can view</Text>
          <Text size='xs' c='dimmed'>No account or sign-in needed</Text>
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
  onCreate: () => Promise<void>;
  onExpiry: (id: string, expiry: LinkExpiry) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
};

/**
 * Sharing by a link that opens the node without signing in. Unlike the people above it, whatever is
 * done here happens at once: a link copied before Save would otherwise open nothing.
 */
export function LinkSection({ links, editable, noun, exceptions, onCreate, onExpiry, onRemove }: LinkSectionProps) {
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
    return (
      <Group gap='sm' wrap='nowrap'>
        <ThemeIcon size={32} radius='xl' variant='light' color='gray' style={{ flex: 'none' }}>
          <IconLink size={18} />
        </ThemeIcon>
        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
          <Text size='sm'>Send a link to someone without an account</Text>
          <Text size='xs' c='dimmed'>Anyone with the link can view the {noun}. It stops working after 30 days, unless you change that.</Text>
        </Stack>
        <Button variant='light' size='compact-sm' loading={busy === 'create'} onClick={() => run('create', onCreate)} style={{ flex: 'none' }}>
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
