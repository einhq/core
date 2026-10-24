import { Alert, Box, Button, Group, PasswordInput, Stack, TextInput, Title } from '@mantine/core';
import { IconAlertCircle, IconLock, IconUser } from '@tabler/icons-react';
import { loginReturnPath } from '@ein/ui/lib';
import { useSignals } from '@preact/signals-react/runtime';
import { guestBrowsing, login } from '@ein/ui/signals';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { EinMark } from '../Layout/EinMark.tsx';

export function LoginForm() {
  useSignals();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (username.trim() === '') {
      setError('Username or e-mail is required');
      setLoading(false);
      return;
    }

    try {
      await login(username, password);
      // A fresh page, so nothing read before — as the guest, or as whoever signed out — is
      // shown to this person.
      globalThis.location.replace(loginReturnPath(params));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      setLoading(false);
    }
  };

  return (
    <Box component='form' onSubmit={handleSubmit} w='100%' maw={360}>
      <Stack gap='xl'>
        <Group gap={10} wrap='nowrap'>
          <EinMark size={32} />
          <Title order={1} size='h2' fw={700} c='marine.5' style={{ fontFamily: '"Mochiy Pop One", sans-serif' }}>
            EiN
          </Title>
        </Group>

        {error && (
          <Alert icon={<IconAlertCircle size={16} />} color='red' variant='light'>
            {error}
          </Alert>
        )}

        <Stack gap='md'>
          <TextInput
            label='Username or e-mail'
            placeholder='Enter your username or e-mail'
            autoCapitalize='none'
            leftSection={<IconUser size={16} />}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            size='md'
            autoFocus
            disabled={loading}
          />

          <PasswordInput
            label='Password'
            placeholder='Enter your password'
            leftSection={<IconLock size={16} />}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            size='md'
            disabled={loading}
          />
        </Stack>

        <Button type='submit' fullWidth size='md' loading={loading}>
          Sign in
        </Button>

        {guestBrowsing.value && (
          <Button variant='subtle' color='gray' fullWidth size='md' disabled={loading} onClick={() => navigate('/')}>
            Browse without signing in
          </Button>
        )}
      </Stack>
    </Box>
  );
}
