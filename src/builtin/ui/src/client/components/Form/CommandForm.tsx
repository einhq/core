import { Alert, Button, Container, Stack, Title } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { execCommand } from '@ein/ui/signals';
import { useState } from 'react';
import { useMatches } from 'react-router-dom';
import { useSurface } from '../../hooks/useSurface.ts';
import { DialogActions } from '../Surface/Dialog.tsx';
import { type FormField, FormFields, type FormValues } from './FormFields.tsx';

export type CommandFormProps = {
  fields: FormField[];
  /** Values to start with, such as what a link already knew (a scanned camera's make and model). */
  initial?: FormValues;
  /** The command line the values make, and the route to open once it has run; throw to show an error. */
  build: (values: FormValues) => { command: string; navigateTo: string };
  submitLabel?: string;
};

/**
 * A route's form that runs one command: the fields, an error if the command fails, and Cancel
 * and submit, which Enter in a field presses too. Shown wherever the route is — in the shell's
 * dialog, which takes its title from the route's `handle` and holds the buttons in its bar, or as
 * a page, where the same title heads it. On success it opens the new thing as the page, closing
 * the dialog.
 */
export function CommandForm({ fields, initial, build, submitLabel = 'Create' }: CommandFormProps) {
  const surface = useSurface();
  const title = useMatches().map((match) => (match.handle as { title?: string } | undefined)?.title).filter(Boolean).at(-1);
  const [values, setValues] = useState<FormValues>(initial ?? {});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missingRequired = fields.some((field) => field.required && !values[field.key]?.trim());

  const submit = async () => {
    if (missingRequired || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { command, navigateTo } = build(values);
      await execCommand(command);
      surface.openPage(navigateTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const form = (
    <form
      className='mrx-dialog-form'
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Stack gap='md'>
        {error && <Alert color='red' icon={<IconAlertCircle size={16} />} variant='light'>{error}</Alert>}
        <FormFields fields={fields} values={values} onChange={setValues} />
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={surface.close}>Cancel</Button>
        <Button type='submit' loading={submitting} disabled={missingRequired}>{submitLabel}</Button>
      </DialogActions>
    </form>
  );

  if (surface.kind !== 'page') return form;
  return (
    <Container size='sm' py='xl'>
      {title && <Title order={2} mb='lg'>{title}</Title>}
      <Stack gap='lg'>{form}</Stack>
    </Container>
  );
}
