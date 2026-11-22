import { Box, Button, Group, Image, Stack, Text } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import type { DeviceAppAnswer } from '@ein/api';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import { formatDateTime } from '../../lib/datetime.ts';
import { shq } from '../../lib/shquote.ts';
import { execCommand } from '../../signals/shell-client.ts';
import { notify } from '../../signals/notify.ts';

/** How often the pairing is read again while its QR code is shown, to see the app take it. */
const WATCH_MS = 3000;

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const when = (iso: string): string => formatDateTime(new Date(iso));

/**
 * The EiN app's pairing with a phone (`device-app`): whether an app is paired, as whom and when it
 * was last used, a QR code with a one-time pairing code for the app to scan, and taking the pairing
 * away, which signs the app out. The code is shown only on the page that made it, which watches
 * the pairing until the app uses the code or it runs out. Only whoever may change the phone sees
 * it: anyone else is shown why not.
 */
export function DeviceApp({ device }: { device: string }) {
  const [answer, setAnswer] = useState<DeviceAppAnswer>();
  const [qr, setQr] = useState<{ svg: string; expiresAt: string }>();
  const [refused, setRefused] = useState<string>();
  const [pending, setPending] = useState<'pair' | 'off'>();
  const [confirmOff, setConfirmOff] = useState(false);

  const run = useCallback(async (flag?: '--pair' | '--off') => {
    const next = await execCommand<DeviceAppAnswer>(`device-app ${shq(device)} --origin ${shq(globalThis.location.origin)}${flag ? ` ${flag}` : ''}`);
    setAnswer(next);
    setQr((shown) => next.qrSvg && next.pairingExpiresAt ? { svg: next.qrSvg, expiresAt: next.pairingExpiresAt } : next.pairingExpiresAt ? shown : undefined);
    return next;
  }, [device]);

  useEffect(() => {
    run().catch((error) => setRefused(messageOf(error)));
  }, [run]);

  useEffect(() => {
    if (!qr) return;
    const timer = setInterval(() => void run().catch(() => {}), WATCH_MS);
    return () => clearInterval(timer);
  }, [qr, run]);

  const change = async (flag: '--pair' | '--off') => {
    setPending(flag === '--pair' ? 'pair' : 'off');
    try {
      await run(flag);
      setConfirmOff(false);
    } catch (error) {
      notify({ message: messageOf(error), color: 'red' });
    } finally {
      setPending(undefined);
    }
  };

  if (refused) return <Text size='sm' c='dimmed'>{refused}</Text>;
  if (!answer) return null;

  return (
    <Stack gap='md'>
      <Text size='sm' c='dimmed'>
        {answer.paired
          ? `The EiN app on this phone is signed in as ${answer.user}, since ${when(answer.pairedAt!)}. Last used ${
            answer.lastUsedAt ? `${when(answer.lastUsedAt)}${answer.lastFrom ? ` from ${answer.lastFrom}` : ''}` : 'never'
          }.`
          : 'Pair the EiN app on this phone: it signs in as you with a key of its own, so your password never reaches it.'}
      </Text>

      {qr && (
        <Group align='flex-start' gap='xl'>
          <Box bg='white' p={4} style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none' }}>
            <Image src={`data:image/svg+xml;utf8,${encodeURIComponent(qr.svg)}`} w={200} h={200} alt='QR code that pairs the EiN app' />
          </Box>
          <Stack gap='xs' style={{ flex: 1, minWidth: 220 }}>
            <Text size='sm'>Scan this code with the EiN app, or with the phone's camera where the app is installed.</Text>
            <Text size='xs' c='dimmed'>
              It works once, until {when(qr.expiresAt)}.{answer.paired ? ' The app paired before is signed out when it is used.' : ''}
            </Text>
          </Stack>
        </Group>
      )}

      <Group gap='xs'>
        {!qr && (
          <Button
            size='xs'
            leftSection={<TablerIcon name='qrcode' size={14} />}
            loading={pending === 'pair'}
            disabled={pending === 'off'}
            onClick={() => change('--pair')}
          >
            {answer.paired ? 'Pair again' : 'Pair the app'}
          </Button>
        )}
        {answer.paired && (confirmOff
          ? (
            <>
              <Text size='sm'>The app is signed out at once.</Text>
              <Button size='xs' color='red' loading={pending === 'off'} onClick={() => change('--off')}>Unpair</Button>
              <Button size='xs' variant='default' onClick={() => setConfirmOff(false)}>Cancel</Button>
            </>
          )
          : (
            <Button
              size='xs'
              variant='default'
              color='red'
              leftSection={<TablerIcon name='plug-connected-x' size={14} />}
              disabled={pending !== undefined}
              onClick={() => setConfirmOff(true)}
            >
              Unpair
            </Button>
          ))}
      </Group>
    </Stack>
  );
}
