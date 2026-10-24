import { Alert, Button, Card, Container, Group, PasswordInput, Stack, Tabs, Text, TextInput } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { IconAdjustments, IconAlertTriangle, IconCheck, IconShield, IconUser } from '@tabler/icons-react';
import { EntityDetailHeader, PageLoader, SettingsForm } from '@ein/ui/components';
import { useConfig } from '@ein/ui/hooks';
import { changePassword, currentUser, updateUser } from '@ein/ui/signals';
import { type CSSProperties, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

const TABS = ['account', 'preferences', 'security'];

/** The quiet confirmation beside a form's button. */
const Done = ({ children }: { children: string }) => (
  <Group gap={4} c='teal'>
    <IconCheck size={16} />
    <Text size='sm'>{children}</Text>
  </Group>
);

const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);

export default function ProfilePage() {
  useSignals();
  const user = currentUser.value;
  // The tab is in the URL, so the documentation can link to Preferences.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = TABS.includes(searchParams.get('tab') ?? '') ? searchParams.get('tab')! : 'account';

  return (
    <Tabs value={tab} onChange={(value) => setSearchParams(value && value !== 'account' ? { tab: value } : {}, { replace: true })}>
      {
        /* A user linked to a person wears that person's cover, as their page does;
          otherwise the people pattern stands in for it. */
      }
      <EntityDetailHeader
        tabs={
          <Tabs.List>
            <Tabs.Tab value='account' leftSection={<IconUser size={16} />}>Account</Tabs.Tab>
            <Tabs.Tab value='preferences' leftSection={<IconAdjustments size={16} />}>Preferences</Tabs.Tab>
            <Tabs.Tab value='security' leftSection={<IconShield size={16} />}>Security</Tabs.Tab>
          </Tabs.List>
        }
        path={user?.personPath}
        pattern='person'
        title={user?.name || user?.username}
        fallback={user?.name?.charAt(0) || <IconUser size={56} />}
        coverColor='marine'
        subtitle={
          <>
            <Text size='sm' c='gray.2'>@{user?.username}</Text>
            {user?.description && <Text size='sm' c='gray.2'>{user.description}</Text>}
          </>
        }
      />

      <Container py='md' px='md' style={{ '--mrx-body-padding': 'var(--mantine-spacing-md)' } as CSSProperties}>
        <Tabs.Panel value='account'>
          <AccountForm />
        </Tabs.Panel>

        <Tabs.Panel value='preferences'>
          <PreferencesForm />
        </Tabs.Panel>

        <Tabs.Panel value='security'>
          <PasswordForm />
        </Tabs.Panel>
      </Container>
    </Tabs>
  );
}

function AccountForm() {
  useSignals();
  const user = currentUser.value;
  const [name, setName] = useState(user?.name || '');
  const [description, setDescription] = useState(user?.description || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(user?.name || '');
    setDescription(user?.description || '');
  }, [user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !user?.username) return;

    setLoading(true);
    setError(undefined);
    setSaved(false);
    try {
      await updateUser(user.username, name, description);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card component='form' onSubmit={handleSubmit} withBorder maw={560}>
      <Stack gap='md'>
        {error && <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />}>{error}</Alert>}
        <TextInput
          label='Display name'
          value={name}
          onChange={(e) => setName(e.target.value)}
          description='Your name as it appears to others'
          disabled={loading}
        />
        <TextInput
          label='Description'
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          description='A line about you, shown under your name'
          disabled={loading}
        />
        <Group gap='sm'>
          <Button type='submit' loading={loading} disabled={!name.trim()}>Save changes</Button>
          {saved && <Done>Saved</Done>}
        </Group>
      </Stack>
    </Card>
  );
}

function PreferencesForm() {
  const { entries, loading, error, save, reset } = useConfig('user');

  return (
    <Stack gap='lg'>
      <Text c='dimmed'>
        These apply to you alone. They are stored in your home directory and follow you to the terminal as well.
      </Text>
      {error && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />}>
          {error.message}
        </Alert>
      )}
      {loading ? <PageLoader label='Loading settings…' /> : <SettingsForm entries={entries} save={save} reset={reset} emptyMessage='No personal settings available.' />}
    </Stack>
  );
}

function PasswordForm() {
  useSignals();
  const user = currentUser.value;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== next;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.username || !next || mismatch) return;

    setLoading(true);
    setError(undefined);
    setSaved(false);
    try {
      await changePassword(user.username, current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card component='form' onSubmit={handleSubmit} withBorder maw={560}>
      <Stack gap='md'>
        {error && <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />}>{error}</Alert>}
        <PasswordInput
          label='Current password'
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete='current-password'
          disabled={loading}
        />
        <PasswordInput
          label='New password'
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete='new-password'
          disabled={loading}
        />
        <PasswordInput
          label='Confirm new password'
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete='new-password'
          error={mismatch && 'Does not match the new password'}
          disabled={loading}
        />
        <Group gap='sm'>
          <Button type='submit' loading={loading} disabled={!current || !next || next !== confirm}>Update password</Button>
          {saved && <Done>Password updated</Done>}
        </Group>
      </Stack>
    </Card>
  );
}
