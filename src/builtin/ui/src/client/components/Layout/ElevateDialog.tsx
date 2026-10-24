import { Alert, Button, PasswordInput, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useState } from 'react';
import { elevate } from '../../signals/user.ts';
import { Dialog, DialogActions } from '../Surface/Dialog.tsx';

/** `user-elevate`'s refusal in words, without the command's name in front. */
const problem = (error: unknown): string => {
  const message = (error instanceof Error ? error.message : String(error)).replace(/^user elevate:\s*/, '').trim();
  return message === 'authentication failed' ? 'That is not your password.' : message;
};

/**
 * Asks a member of the `sudo` group for their password again and makes this session's sign-in an
 * administrator's, then loads the page again, so the navigation and settings are read as one.
 */
export function ElevateDialog({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => {
    setPassword('');
    setError('');
    onClose();
  };

  const submit = async () => {
    if (password === '' || busy) return;
    setBusy(true);
    setError('');
    try {
      await elevate(password);
      globalThis.location.reload();
    } catch (err) {
      setError(problem(err));
      setBusy(false);
    }
  };

  return (
    <Dialog opened={opened} onClose={close} title='Administer' icon='shield-up' pattern='system' size='sm' floating onSubmit={() => void submit()}>
      <Text size='sm' mb='md'>
        Enter your password again to act as the administrator until you sign out or leave admin mode.
      </Text>
      {error && (
        <Alert icon={<IconAlertCircle size={16} />} color='red' variant='light' mb='md'>
          {error}
        </Alert>
      )}
      <PasswordInput data-autofocus label='Password' value={password} onChange={(event) => setPassword(event.currentTarget.value)} disabled={busy} />
      <DialogActions>
        <Button variant='default' onClick={close}>Cancel</Button>
        <Button type='submit' loading={busy} disabled={password === ''}>Administer</Button>
      </DialogActions>
    </Dialog>
  );
}
