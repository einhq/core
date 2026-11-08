import { ActionIcon, Anchor, Box, Button, Group, Image, List, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceKeyAnswer } from '@ein/api';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import { copyText } from '../../lib/clipboard.ts';
import { shq } from '../../lib/shquote.ts';
import { execCommand } from '../../signals/shell-client.ts';
import { notify } from '../../signals/notify.ts';

const TRACCAR_CLIENT = 'https://www.traccar.org/client/';

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * The key that lets a device write to `/file/dev/<device>` without signing in (`device-key`): whether
 * it has one, the URL it is given with the key in it and a QR code of that, and making a key, a new
 * one in its place (after a confirm, since the old URL stops working) or taking it away. A `tracker`
 * device is a phone or GPS tracker, so it says how to set Traccar Client up with the code. Only
 * whoever may change the device sees the key: anyone else is shown why not, as the command says it.
 */
export function DeviceKey({ device, driver }: { device: string; driver?: string }) {
  const [answer, setAnswer] = useState<DeviceKeyAnswer>();
  const [refused, setRefused] = useState<string>();
  const [pending, setPending] = useState<'new' | 'off'>();
  const [confirmNew, setConfirmNew] = useState(false);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const tracker = driver === 'tracker';

  const run = useCallback(async (flag?: '--new' | '--off') => {
    const next = await execCommand<DeviceKeyAnswer>(`device-key ${shq(device)} --origin ${shq(globalThis.location.origin)}${flag ? ` ${flag}` : ''}`);
    setAnswer(next);
    return next;
  }, [device]);

  useEffect(() => {
    run().catch((error) => setRefused(messageOf(error)));
  }, [run]);

  const change = async (flag: '--new' | '--off') => {
    setPending(flag === '--new' ? 'new' : 'off');
    try {
      await run(flag);
      setConfirmNew(false);
    } catch (error) {
      notify({ message: messageOf(error), color: 'red' });
    } finally {
      setPending(undefined);
    }
  };

  const copy = async () => {
    if (!answer?.url) return;
    if (!(await copyText(answer.url, input.current))) {
      notify({ message: 'The browser would not copy the address: it is selected for you to copy.', color: 'yellow' });
      return;
    }
    notify({ message: 'Device URL copied to clipboard' });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (refused) return <Text size='sm' c='dimmed'>{refused}</Text>;
  if (!answer) return null;

  return (
    <Stack gap='md'>
      <Group justify='space-between' align='flex-start' wrap='nowrap'>
        <Text size='sm' c='dimmed'>
          {answer.enabled
            ? 'The device writes to EiN at this address, without signing in; its driver reads what it sends.'
            : tracker
            ? 'Let a phone, or a GPS tracker that posts over HTTP, send its position to this device as it moves.'
            : 'The device has no key: nothing writes to it without signing in. Make one to give it an address to post to.'}
        </Text>
        {!answer.enabled && (
          // Kept at its own width: beside the text it would be squeezed until its label is clipped.
          <Button leftSection={<TablerIcon name='key' size={16} />} loading={pending === 'new'} onClick={() => change('--new')} style={{ flexShrink: 0 }}>
            Make a key
          </Button>
        )}
      </Group>

      {answer.enabled && answer.url && (
        <Group align='flex-start' gap='xl'>
          {answer.qrSvg && (
            <Box bg='white' p={4} style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none' }}>
              <Image src={`data:image/svg+xml;utf8,${encodeURIComponent(answer.qrSvg)}`} w={200} h={200} alt="QR code of the device's address" />
            </Box>
          )}
          <Stack gap='sm' style={{ flex: 1, minWidth: 260 }}>
            {tracker && (
              <List type='ordered' size='sm' spacing={6}>
                <List.Item>
                  Install <Anchor href={TRACCAR_CLIENT} target='_blank' rel='noreferrer'>Traccar Client</Anchor> on the phone, from Google Play or the App Store.
                </List.Item>
                <List.Item>In its settings, scan this QR code. It fills in the server URL and the device identifier.</List.Item>
                <List.Item>Set how often it reports, for example every 30 seconds, and switch tracking on.</List.Item>
              </List>
            )}
            <TextInput
              ref={input}
              size='xs'
              readOnly
              label={tracker ? 'Or type the server URL in by hand' : 'The address the device posts to'}
              value={answer.url}
              onClick={copy}
              rightSectionPointerEvents='all'
              rightSection={
                <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                  <ActionIcon variant='subtle' color={copied ? 'teal' : 'gray'} size='sm' onClick={copy} aria-label='Copy the device URL'>
                    <TablerIcon name={copied ? 'check' : 'copy'} size={14} />
                  </ActionIcon>
                </Tooltip>
              }
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', cursor: 'pointer' } }}
            />
            <Text size='xs' c='dimmed'>
              The device has to reach EiN at this address from wherever it is, over HTTPS. Anyone who has the address can write to the device: make a new key if it got out.
            </Text>
            <Group gap='xs'>
              {confirmNew
                ? (
                  <>
                    <Text size='sm'>The device stops reaching EiN until it is given the new address.</Text>
                    <Button size='xs' color='red' loading={pending === 'new'} onClick={() => change('--new')}>Make a new key</Button>
                    <Button size='xs' variant='default' onClick={() => setConfirmNew(false)}>Cancel</Button>
                  </>
                )
                : (
                  <>
                    <Button
                      size='xs'
                      variant='default'
                      leftSection={<TablerIcon name='refresh' size={14} />}
                      onClick={() => setConfirmNew(true)}
                      disabled={pending !== undefined}
                    >
                      New key
                    </Button>
                    <Button
                      size='xs'
                      variant='default'
                      color='red'
                      leftSection={<TablerIcon name='key-off' size={14} />}
                      loading={pending === 'off'}
                      disabled={pending === 'new'}
                      onClick={() => change('--off')}
                    >
                      Take the key away
                    </Button>
                  </>
                )}
            </Group>
          </Stack>
        </Group>
      )}
    </Stack>
  );
}
