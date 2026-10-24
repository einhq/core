import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useAccessIds } from '../../hooks/useAccessIds.ts';
import type { NodeStat } from '../../hooks/useNodeStat.ts';
import { canWrite, describeNodeError } from '../../lib/access.ts';
import { attrsWriteArgs, parseAttrsJson } from '../../lib/node-attrs-flat.ts';
import { parentPath } from '../../lib/node-path.ts';
import { shq } from '../../lib/shquote.ts';
import { invalidateListing } from '../../signals/nodes.ts';
import { execCommand } from '../../signals/shell-client.ts';
import { CodeMirror } from '../CodeEditor/CodeMirror.tsx';

/** The editor's line height at its font size, and its shortest and tallest. */
const LINE = 18;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 560;

const pretty = (attrs: Record<string, unknown>): string => JSON.stringify(attrs, null, 2);

type NodeAttributesProps = {
  path: string;
  /** `stat -L` of the node; the tool waits for it, since a listing's attrs may be a moment old. */
  stat: NodeStat | null;
  refetch: () => void;
};

/**
 * The Attributes tool: a node's attributes as one JSON object, edited in
 * location. Save stays off until the text is an object the `attrs` command can
 * take (`parseAttrsJson`), and writes only the top-level keys that changed,
 * as the properties dialog's table does, so an attribute the server set
 * meanwhile on another key is not overwritten with the old value.
 */
export function NodeAttributes({ path, stat, refetch }: NodeAttributesProps) {
  const access = useAccessIds();
  const original = useMemo(() => (stat?.node.attrs ?? {}) as Record<string, unknown>, [stat]);
  const [text, setText] = useState(() => pretty(original));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // A fresh `stat` (another node, or this one after a save) replaces the text.
  useEffect(() => {
    setText(pretty(original));
    setFailure(null);
  }, [original]);
  useEffect(() => setSaved(false), [path]);

  if (!stat) return null;

  const editable = stat.share?.canEdit ?? canWrite(stat.node.props, access);
  const parsed = parseAttrsJson(text);
  const args = parsed.ok ? attrsWriteArgs(original, parsed.value, shq) : [];
  const dirty = text !== pretty(original);

  const save = async () => {
    if (args.length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      await execCommand(`attrs ${args.join(' ')} ${shq(path)}`);
      setSaved(true);
      invalidateListing(parentPath(path));
      refetch();
    } catch (err) {
      setFailure(describeNodeError(err));
    } finally {
      setBusy(false);
    }
  };

  const lines = text.split('\n').length;
  // Room below the last line for the sideways scrollbar a long value brings.
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, lines * LINE + 24));

  return (
    <Stack gap='xs'>
      <CodeMirror
        value={text}
        onChange={editable
          ? (next) => {
            // The editor echoes a text set from here (a reset, a fresh stat); only a typed change is an edit.
            if (next === text) return;
            setText(next);
            setSaved(false);
          }
          : undefined}
        readOnly={!editable}
        language='json'
        height={`${height}px`}
      />
      {!parsed.ok && dirty && (
        <Text size='xs' c='red'>
          {parsed.message}
        </Text>
      )}
      {failure && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} withCloseButton onClose={() => setFailure(null)}>
          {failure}
        </Alert>
      )}
      {editable
        ? (
          <Group gap='xs' justify='flex-end'>
            {saved && !dirty && (
              <Text size='xs' c='dimmed' style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <IconCheck size={14} /> Saved
              </Text>
            )}
            <Button size='compact-sm' variant='subtle' color='gray' disabled={!dirty || busy} onClick={() => setText(pretty(original))}>
              Reset
            </Button>
            <Button size='compact-sm' disabled={!parsed.ok || args.length === 0} loading={busy} onClick={save}>
              Save
            </Button>
          </Group>
        )
        : <Text size='xs' c='dimmed'>You can read these attributes but not change them.</Text>}
    </Stack>
  );
}
