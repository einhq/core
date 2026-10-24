import { Alert, Anchor, Badge, Button, Text } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { IconAlertTriangle, IconDeviceFloppy } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { type CodeLanguage, languageFor } from '../../lib/code-language.ts';
import { fileUrl } from '../../lib/file-url.ts';
import { baseName } from '../../lib/node-path.ts';
import { closeCodeEditor, type CodeEditorRequest, codeEditorRequest } from '../../signals/code-editor.ts';
import { CodeMirror } from './CodeMirror.tsx';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { Dialog, DialogActions } from '../Surface/Dialog.tsx';

/** Above this a file is left to the raw URL: the editor holds the whole document in memory. */
const SIZE_LIMIT = 2 * 1024 * 1024;

type Loaded = { text: string; language: CodeLanguage; readOnly: boolean };
type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'too-large'; size: number } | ({ kind: 'ready' } & Loaded);

const titleOf = (request: CodeEditorRequest): string => request.kind === 'file' ? request.title ?? baseName(request.path) : request.title;

async function loadFile(request: Extract<CodeEditorRequest, { kind: 'file' }>): Promise<LoadState> {
  const res = await fetch(fileUrl(request.path));
  if (!res.ok) return { kind: 'error', message: `could not read ${request.path} (${res.status})` };
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > SIZE_LIMIT) return { kind: 'too-large', size: length };
  const text = await res.text();
  if (text.length > SIZE_LIMIT) return { kind: 'too-large', size: text.length };
  const mimetype = request.mimetype ?? res.headers.get('content-type') ?? undefined;
  return { kind: 'ready', text, language: request.language ?? languageFor(mimetype, baseName(request.path)), readOnly: request.readOnly === true };
}

async function saveFile(path: string, text: string, mimetype: string | undefined): Promise<void> {
  const res = await fetch(fileUrl(path), {
    method: 'PUT',
    headers: { 'Content-Type': mimetype ?? 'text/plain' },
    body: text,
  });
  if (!res.ok) throw new Error(`could not write ${path} (${res.status})`);
}

function CodeEditorDialog({ request, opened, onClose }: { request: CodeEditorRequest; opened: boolean; onClose: () => void }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ready = (loaded: Loaded) => {
      if (cancelled) return;
      setState({ kind: 'ready', ...loaded });
      setText(loaded.text);
      setSaved(loaded.text);
    };
    if (request.kind === 'text') {
      ready({ text: request.value, language: request.language ?? 'text', readOnly: request.readOnly === true || request.onSave === undefined });
    } else {
      loadFile(request).then((result) => {
        if (cancelled) return;
        if (result.kind === 'ready') ready(result);
        else setState(result);
      }, (error: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [request]);

  const readOnly = state.kind === 'ready' && state.readOnly;
  const dirty = state.kind === 'ready' && !readOnly && text !== saved;

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (request.kind === 'file') await saveFile(request.path, text, request.mimetype);
      else await request.onSave?.(text);
      setSaved(text);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, request, text]);

  const requestClose = useCallback(() => {
    if (dirty) setConfirmClose(true);
    else onClose();
  }, [dirty, onClose]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  };

  const rawUrl = request.kind === 'file' ? fileUrl(request.path) : undefined;

  return (
    <Dialog
      opened={opened}
      onClose={requestClose}
      size='90%'
      closeOnEscape={!dirty}
      title={titleOf(request)}
      subtitle={request.kind === 'file' && <Text span ff='monospace' size='sm' inherit>{request.path}</Text>}
      aside={
        <>
          {state.kind === 'ready' && <Badge variant='light' size='sm'>{state.language}</Badge>}
          {readOnly && <Badge variant='light' color='gray' size='sm'>read-only</Badge>}
          {dirty && <Badge variant='light' color='yellow' size='sm'>unsaved</Badge>}
        </>
      }
      icon='code'
      pattern='system'
    >
      {/* As tall as the window leaves it beside the header and the bar, and taller where a full-screen dialog has the room. */}
      <div onKeyDown={onKeyDown} style={{ flex: '1 0 auto', height: 'min(70vh, calc(90dvh - 230px))', minHeight: 240, display: 'flex', flexDirection: 'column' }}>
        {state.kind === 'loading' && <PageLoader />}
        {state.kind === 'error' && <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />}>{state.message}</Alert>}
        {state.kind === 'too-large' && (
          <Alert color='yellow' variant='light' icon={<IconAlertTriangle size={16} />}>
            Too large to edit here ({Math.round(state.size / 1024)} KB). <Anchor href={rawUrl} target='_blank' rel='noopener'>Open the raw file</Anchor> instead.
          </Alert>
        )}
        {state.kind === 'ready' && <CodeMirror value={text} onChange={readOnly ? undefined : setText} language={state.language} readOnly={readOnly} autoFocus />}
      </div>
      {saveError && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} withCloseButton onClose={() => setSaveError(null)}>
          {saveError}
        </Alert>
      )}
      {confirmClose
        ? (
          <DialogActions hint={<Text size='sm' c='var(--mrx-text-primary)'>Discard unsaved changes?</Text>}>
            <Button variant='default' onClick={() => setConfirmClose(false)}>Keep editing</Button>
            <Button color='red' onClick={onClose}>Discard</Button>
          </DialogActions>
        )
        : (
          <DialogActions hint={rawUrl && <Anchor href={rawUrl} target='_blank' rel='noopener' size='sm'>Raw</Anchor>}>
            <Button variant='default' onClick={requestClose}>Close</Button>
            {!readOnly && state.kind === 'ready' && (
              <Button leftSection={<IconDeviceFloppy size={16} />} onClick={() => void save()} disabled={!dirty} loading={saving}>
                Save
              </Button>
            )}
          </DialogActions>
        )}
    </Dialog>
  );
}

/** The request being shown, and which opening of the dialog this is. */
type Session = { request: CodeEditorRequest; opening: number };

/**
 * The one code editor dialog, mounted at the app root like the lightbox and
 * the sharing dialog.
 *
 * Anything may ask for it with `openCodeEditor`; the request lives in a signal
 * because the asking control is usually a `Menu.Item`, whose dropdown Mantine
 * unmounts on click. The session outlives the request so the dialog can fade
 * out, and its opening number keys the dialog so a fresh opening never shows
 * the previous one's text while it loads.
 */
export function CodeEditorModal() {
  useSignals();
  const request = codeEditorRequest.value;
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (request !== null) setSession((current) => ({ request, opening: (current?.opening ?? 0) + 1 }));
  }, [request]);

  if (!session) return null;

  return <CodeEditorDialog key={session.opening} request={session.request} opened={request !== null} onClose={closeCodeEditor} />;
}
