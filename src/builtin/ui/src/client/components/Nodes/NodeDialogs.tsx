import { Alert, Button, Checkbox, Code, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { nameProblem as problemOf } from '../../lib/node-path.ts';
import { Dialog, DialogActions } from '../Surface/Dialog.tsx';

export type NodeDialog =
  | { kind: 'mkdir'; parent: string }
  | { kind: 'delete'; paths: string[]; nonEmpty: number };

type NodeDialogsProps = {
  dialog: NodeDialog | null;
  onClose: () => void;
  busy: boolean;
  onMkdir: (parent: string, name: string) => Promise<boolean>;
  onDelete: (paths: string[], recursive: boolean) => Promise<boolean>;
};

/**
 * New directory and delete. A rename is done in the row itself
 * (`NodeNameInput`); a new directory has no row to do it in yet.
 */
export function NodeDialogs({ dialog, onClose, busy, onMkdir, onDelete }: NodeDialogsProps) {
  const [name, setName] = useState('');
  const [recursive, setRecursive] = useState(false);

  useEffect(() => {
    if (dialog?.kind === 'mkdir') setName('');
    if (dialog?.kind === 'delete') setRecursive(dialog.nonEmpty > 0);
  }, [dialog]);

  const nameProblem = problemOf(name);

  const submitName = async () => {
    if (dialog?.kind !== 'mkdir' || nameProblem) return;
    if (await onMkdir(dialog.parent, name)) onClose();
  };

  if (dialog?.kind === 'mkdir') {
    return (
      <Dialog
        opened
        onClose={onClose}
        title='New directory'
        subtitle={<Text span ff='monospace' size='sm' inherit>{dialog.parent}</Text>}
        icon='folder-plus'
        pattern='system'
        size='sm'
        onSubmit={submitName}
      >
        <TextInput
          data-autofocus
          label='Name'
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          error={name.length > 0 ? nameProblem : undefined}
        />
        <DialogActions>
          <Button variant='default' onClick={onClose}>Cancel</Button>
          <Button type='submit' loading={busy} disabled={nameProblem !== null}>Create</Button>
        </DialogActions>
      </Dialog>
    );
  }

  if (dialog?.kind === 'delete') {
    const many = dialog.paths.length > 1;
    return (
      <Dialog
        opened
        onClose={onClose}
        title={many ? `Delete ${dialog.paths.length} nodes?` : 'Delete this node?'}
        icon='trash'
        pattern='danger'
        size='sm'
        floating
      >
        <Stack gap='sm'>
          {!many && <Code block>{dialog.paths[0]}</Code>}
          {dialog.nonEmpty > 0 && (
            <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />}>
              {many ? (dialog.nonEmpty === 1 ? 'One of them has' : `${dialog.nonEmpty} of them have`) : 'It has'} children. Deleting recursively removes everything underneath.
            </Alert>
          )}
          <Checkbox label='Delete recursively (rm -r)' checked={recursive} onChange={(event) => setRecursive(event.currentTarget.checked)} />
        </Stack>
        <DialogActions>
          <Button variant='default' onClick={onClose}>Cancel</Button>
          <Button
            color='red'
            loading={busy}
            onClick={async () => {
              if (await onDelete(dialog.paths, recursive)) onClose();
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  return null;
}
