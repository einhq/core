import { Alert, Box, Button, Flex, Group, Loader, Paper, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { IconAlertCircle, IconLinkOff, IconLock, IconLogin2 } from '@tabler/icons-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { UserInviteAccepted } from '@ein/api';
import { HatField } from '../components/EntityDetail/HatField.tsx';
import { EinMark } from '../components/Layout/EinMark.tsx';
import { shq } from '../lib/shquote.ts';
import { execCommand } from '../signals/shell-client.ts';

/**
 * `/invite/<token>`: where a sign-in link lands. It names the account the link is for, its username
 * above all, which the person may not know, and lets them choose its password; that spends the link
 * and signs them in. A link that no longer works says so, and offers signing in.
 *
 * Drawn outside the frame, like the sign-in page, because the visitor has nothing else to see yet.
 */
export default function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [account, setAccount] = useState<UserInviteAccepted | null>(null);
  const [failed, setFailed] = useState(false);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    execCommand<UserInviteAccepted>(`user-invite-accept ${shq(token)}`).then(
      (found) => !cancelled && setAccount(found),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  const mismatch = repeat !== '' && repeat !== password;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || password !== repeat) return;
    setBusy(true);
    setError('');
    try {
      // `--password=` so a password that starts with a dash is not read as another flag.
      await execCommand(`user-invite-accept ${shq(token)} --password=${shq(password)} --session`);
      // A fresh page, so nothing read as the guest is shown to the person now signed in.
      globalThis.location.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Flex className='mrx-pattern' data-pattern='mixed' h='100vh' w='100vw' justify='center' align='center' p='xl'>
      <Box pos='absolute' inset={0}>
        <HatField pattern='mixed' kind='backdrop' />
      </Box>
      <Paper withBorder p='xl' radius='md' w='100%' maw={420}>
        <Stack gap='xl'>
          <Group gap={10} wrap='nowrap'>
            <EinMark size={32} />
            <Title order={1} size='h2' fw={700} c='marine.5' style={{ fontFamily: '"Mochiy Pop One", sans-serif' }}>
              EiN
            </Title>
          </Group>

          {failed
            ? (
              <Stack gap='md'>
                <Group gap='xs' wrap='nowrap'>
                  <IconLinkOff size={22} />
                  <Title order={2} size='h4'>This link no longer works</Title>
                </Group>
                <Text size='sm' c='dimmed'>
                  It may have expired, been used already, or been replaced by a newer one. Ask an administrator to send you a new link.
                </Text>
                <Button variant='light' leftSection={<IconLogin2 size={16} />} onClick={() => navigate('/login')}>
                  Sign in
                </Button>
              </Stack>
            )
            : account
            ? (
              <Stack component='form' gap='md' onSubmit={submit}>
                <Stack gap={4}>
                  <Title order={2} size='h4'>Welcome{account.title ? `, ${account.title}` : ''}</Title>
                  <Text size='sm'>
                    Your username is <b>{account.username}</b>. Choose a password to sign in with it; you can also sign in with your e-mail address if the account has one.
                  </Text>
                </Stack>

                {error && (
                  <Alert icon={<IconAlertCircle size={16} />} color='red' variant='light'>
                    {error}
                  </Alert>
                )}

                {/* The username rides along hidden, so a password manager saves the two together. */}
                <input type='text' name='username' autoComplete='username' value={account.username} readOnly hidden />
                <PasswordInput
                  label='Password'
                  autoComplete='new-password'
                  leftSection={<IconLock size={16} />}
                  value={password}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                  size='md'
                  autoFocus
                  disabled={busy}
                />
                <PasswordInput
                  label='Repeat'
                  autoComplete='new-password'
                  leftSection={<IconLock size={16} />}
                  value={repeat}
                  onChange={(event) => setRepeat(event.currentTarget.value)}
                  error={mismatch && 'Does not match'}
                  size='md'
                  disabled={busy}
                />
                <Button type='submit' fullWidth size='md' loading={busy} disabled={!password || password !== repeat}>
                  Set password and sign in
                </Button>
              </Stack>
            )
            : (
              <Group gap='sm' wrap='nowrap'>
                <Loader size='sm' />
                <Text>Opening your sign-in link…</Text>
              </Group>
            )}
        </Stack>
      </Paper>
    </Flex>
  );
}
