import { ActionIcon, Alert, Badge, Button, Checkbox, Code, Group, Loader, Select, SimpleGrid, Stack, Table, Tabs, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconListDetails, IconPlus, IconShare, IconTrash } from '@tabler/icons-react';
import { useSignals } from '@preact/signals-react/runtime';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useAccessIds } from '../../hooks/useAccessIds.ts';
import { useIdentities } from '../../hooks/useIdentities.ts';
import { useNodeOps } from '../../hooks/useNodeOps.ts';
import { type NodeStat, useNodeStat } from '../../hooks/useNodeStat.ts';
import { canWrite } from '../../lib/access.ts';
import { formatBytes } from '../../lib/format.ts';
import { attrsWriteArgs, attrText, attrValue, changedTopLevel, type FlatAttr, flattenAttrs, unflattenAttrs } from '../../lib/node-attrs-flat.ts';
import { toMillis } from '../../lib/node-entry.ts';
import { hasBit, type ModeBit, type ModeClass, modeOctal, modeString, parseOctal, withBit } from '../../lib/node-mode.ts';
import { shq } from '../../lib/shquote.ts';
import { execCommand } from '../../signals/shell-client.ts';
import { SharePanel } from '../Share/ShareModal.tsx';
import { formatWhen } from './NodeRow.tsx';

const CLASSES: { cls: ModeClass; label: string }[] = [{ cls: 'owner', label: 'Owner' }, { cls: 'group', label: 'Group' }, { cls: 'other', label: 'Other' }];
const BITS: ModeBit[] = ['r', 'w', 'x'];

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Table.Tr>
      <Table.Td w={90}>
        <Text size='xs' c='dimmed'>{label}</Text>
      </Table.Td>
      <Table.Td>
        <Text size='xs' style={{ wordBreak: 'break-all' }}>{children}</Text>
      </Table.Td>
    </Table.Tr>
  );
}

const errorAlert = (error: Error | null, onClose?: () => void) =>
  error && (
    <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} withCloseButton={!!onClose} onClose={onClose}>
      {error.message}
    </Alert>
  );

/**
 * Facts on the left, mode and ownership on the right.
 *
 * The mode grid and the owner/group pickers go to `chmod` and `chown`
 * directly, because that is what an administrator looking at a raw node
 * wants to set. Grants to people and groups live on the Sharing tab, which
 * is the sharing dialog itself; a second editor for the same bits would only
 * disagree with it.
 */
function GeneralTab({ path, stat, editable, refetch }: { path: string; stat: NodeStat; editable: boolean; refetch: () => void }) {
  const { names, users, groups } = useIdentities();
  const ops = useNodeOps();
  const props = stat.node.props;

  // Each time carries who caused it; the name says more than the moment alone.
  const when = (time: { uid: number; timestamp: number | string }) => (
    <>
      {formatWhen(toMillis(time.timestamp))} <Text span size='xs' c='dimmed'>by {names.users.get(time.uid) ?? time.uid}</Text>
    </>
  );

  const [mode, setMode] = useState(props.mode & 0o777);
  const [octal, setOctal] = useState(modeOctal(props.mode));
  const [owner, setOwner] = useState<string | null>(String(props.uid));
  const [group, setGroup] = useState<string | null>(String(props.gid));

  useEffect(() => {
    setMode(props.mode & 0o777);
    setOctal(modeOctal(props.mode));
    setOwner(String(props.uid));
    setGroup(String(props.gid));
  }, [props]);

  const modeChanged = mode !== (props.mode & 0o777);
  const ownerChanged = owner !== String(props.uid) || group !== String(props.gid);

  const applyMode = (next: number) => {
    setMode(next);
    setOctal(modeOctal(next));
  };

  const save = async () => {
    let ok = true;
    if (modeChanged) ok = await ops.chmod(path, mode);
    if (ok && ownerChanged) {
      const user = users.find((entry) => String(entry.uid) === owner)?.username ?? owner ?? String(props.uid);
      const grp = groups.find((entry) => String(entry.gid) === group)?.groupname ?? group ?? undefined;
      ok = await ops.chown(path, user, grp);
    }
    if (ok) refetch();
  };

  // One option per id: Mantine throws on a repeated value, so two groups
  // made by hand with the same gid would take the whole page down.
  const identityOptions = (entries: { value: string; label: string }[], current: number) => {
    const unique = entries.filter((entry, index) => entries.findIndex((other) => other.value === entry.value) === index);
    return unique.some((entry) => entry.value === String(current)) ? unique : [...unique, { value: String(current), label: String(current) }];
  };

  return (
    <Stack gap='sm'>
      {errorAlert(ops.error, ops.clearError)}
      <SimpleGrid cols={2} spacing='lg'>
        <Table verticalSpacing={2} withRowBorders={false}>
          <Table.Tbody>
            <Row label='Id'>
              <Code>{stat.node.id}</Code>
            </Row>
            <Row label='Type'>
              <Badge size='sm' variant='light'>{stat.node.type}</Badge>
              {props.tier && <Badge size='sm' variant='outline' color='gray' ml={4}>{props.tier}</Badge>}
            </Row>
            {typeof stat.node.attrs.mimetype === 'string' && <Row label='Mimetype'>{stat.node.attrs.mimetype}</Row>}
            {typeof stat.node.attrs.size === 'number' && <Row label='Size'>{formatBytes(stat.node.attrs.size)} ({stat.node.attrs.size.toLocaleString()} bytes)</Row>}
            {props.softlink && (
              <Row label='Link to'>
                <Code>{props.softlink}</Code>
              </Row>
            )}
            <Row label='Links'>{props.count}</Row>
            <Row label='Created'>{when(props.birthtime)}</Row>
            <Row label='Changed'>{when(props.changetime)}</Row>
            <Row label='Modified'>{when(props.modtime)}</Row>
          </Table.Tbody>
        </Table>

        <Stack gap='sm'>
          <Group gap='xs' align='flex-end' wrap='nowrap'>
            <TextInput
              label='Mode'
              size='xs'
              w={80}
              ff='monospace'
              value={octal}
              disabled={!editable}
              onChange={(event) => {
                setOctal(event.currentTarget.value);
                const parsed = parseOctal(event.currentTarget.value);
                if (parsed !== undefined) setMode(parsed);
              }}
              error={parseOctal(octal) === undefined}
            />
            <Text size='sm' ff='monospace' pb={6}>{modeString(mode)}</Text>
          </Group>
          {
            /* A grid rather than a table: the header letters must sit exactly over
              the boxes, and a table cell's padding puts them a little off. */
          }
          <div style={{ display: 'grid', gridTemplateColumns: '4rem repeat(3, 2.5rem)', rowGap: 6, alignItems: 'center', justifyItems: 'center' }}>
            <span />
            {BITS.map((bit) => <Text key={bit} size='xs' c='dimmed' ff='monospace'>{bit}</Text>)}
            {CLASSES.map(({ cls, label }) => (
              <Fragment key={cls}>
                <Text size='xs' style={{ justifySelf: 'start' }}>{label}</Text>
                {BITS.map((bit) => (
                  <Checkbox
                    key={`${cls}-${bit}`}
                    size='xs'
                    checked={hasBit(mode, cls, bit)}
                    disabled={!editable}
                    onChange={(event) => applyMode(withBit(mode, cls, bit, event.currentTarget.checked))}
                    aria-label={`${label} ${bit}`}
                  />
                ))}
              </Fragment>
            ))}
          </div>
          <Select
            label='Owner'
            size='xs'
            searchable
            value={owner}
            disabled={!editable}
            onChange={setOwner}
            data={identityOptions(users.map((user) => ({ value: String(user.uid), label: `${user.username} (${user.uid})` })), props.uid)}
          />
          <Select
            label='Group'
            size='xs'
            searchable
            value={group}
            disabled={!editable}
            onChange={setGroup}
            data={identityOptions(groups.map((entry) => ({ value: String(entry.gid), label: `${entry.groupname} (${entry.gid})` })), props.gid)}
          />
          <Group gap='xs'>
            <Button size='xs' onClick={save} disabled={!editable || (!modeChanged && !ownerChanged) || parseOctal(octal) === undefined} loading={ops.busy}>Apply</Button>
            {(modeChanged || ownerChanged) && (
              <Button
                size='xs'
                variant='subtle'
                onClick={() => {
                  applyMode(props.mode & 0o777);
                  setOwner(String(props.uid));
                  setGroup(String(props.gid));
                }}
              >
                Reset
              </Button>
            )}
          </Group>
        </Stack>
      </SimpleGrid>
    </Stack>
  );
}

/**
 * Every attribute as a row: dotted key, value, delete. Edits are written
 * back per top-level key with `attrs -J`, since that is the unit the command
 * takes; a deleted top-level key goes with `-d`.
 */
function AttributesTab({ path, stat, editable, refetch }: { path: string; stat: NodeStat; editable: boolean; refetch: () => void }) {
  const original = stat.node.attrs;
  const [rows, setRows] = useState<FlatAttr[]>(() => flattenAttrs(original));
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRows(flattenAttrs(original));
    setTexts({});
  }, [original]);

  const originalLeaf = useMemo(() => new Map(flattenAttrs(original).map((row) => [row.key, row.value])), [original]);

  const current = (row: FlatAttr): unknown => row.key in texts ? attrValue(texts[row.key], originalLeaf.get(row.key)) : row.value;
  const draft = useMemo(() => unflattenAttrs(rows.map((row) => ({ key: row.key, value: current(row) })), original), [rows, texts, original]);
  const changes = changedTopLevel(original, draft);
  const dirty = changes.set.length > 0 || changes.unset.length > 0;
  const badKey = rows.some((row) => row.key.trim() === '' || /^\.|\.$|\.\./.test(row.key) || row.key.includes('=')) ||
    new Set(rows.map((row) => row.key)).size !== rows.length;

  const save = async () => {
    setBusy(true);
    try {
      await execCommand(`attrs ${attrsWriteArgs(original, draft, shq).join(' ')} ${shq(path)}`);
      setError(null);
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap='sm'>
      {errorAlert(error, () => setError(null))}
      <Table verticalSpacing={2} withRowBorders={false} layout='fixed'>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w='40%'>
              <Text size='xs' c='dimmed'>Key</Text>
            </Table.Th>
            <Table.Th>
              <Text size='xs' c='dimmed'>Value</Text>
            </Table.Th>
            <Table.Th w={40} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row, index) => (
            <Table.Tr key={index}>
              <Table.Td>
                <TextInput
                  size='xs'
                  ff='monospace'
                  value={row.key}
                  disabled={!editable}
                  onChange={(event) => setRows(rows.map((r, i) => i === index ? { ...r, key: event.currentTarget.value } : r))}
                />
              </Table.Td>
              <Table.Td>
                <TextInput
                  size='xs'
                  ff='monospace'
                  value={row.key in texts ? texts[row.key] : attrText(row.value)}
                  disabled={!editable}
                  onChange={(event) => setTexts({ ...texts, [row.key]: event.currentTarget.value })}
                />
              </Table.Td>
              <Table.Td>
                <ActionIcon variant='subtle' color='gray' size='sm' disabled={!editable} onClick={() => setRows(rows.filter((_, i) => i !== index))} aria-label='Remove'>
                  <IconTrash size={14} />
                </ActionIcon>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Group gap='xs'>
        <Button size='xs' variant='light' leftSection={<IconPlus size={14} />} disabled={!editable} onClick={() => setRows([...rows, { key: '', value: '' }])}>Add</Button>
        <Button size='xs' onClick={save} disabled={!editable || !dirty || badKey} loading={busy}>Apply</Button>
        {dirty && (
          <Button
            size='xs'
            variant='subtle'
            onClick={() => {
              setRows(flattenAttrs(original));
              setTexts({});
            }}
          >
            Reset
          </Button>
        )}
      </Group>
    </Stack>
  );
}

/** The properties dialog's body, whose header names the path: General, Attributes and Sharing tabs. */
export function NodeProperties({ path }: { path: string | null }) {
  useSignals();
  const { stat, loading, error, refetch } = useNodeStat(path);
  const access = useAccessIds();

  if (!path) return <Text size='sm' c='dimmed'>Select one node to see its properties.</Text>;

  const editable = stat ? (stat.share?.canEdit ?? canWrite(stat.node.props, access)) : false;

  return (
    <Stack gap='sm'>
      {loading && !stat && <Loader size='sm' />}
      {errorAlert(error)}
      {stat && (
        <Tabs defaultValue='general' keepMounted={false}>
          <Tabs.List mb='sm'>
            <Tabs.Tab value='general' leftSection={<IconInfoCircle size={14} />}>General</Tabs.Tab>
            <Tabs.Tab value='attributes' leftSection={<IconListDetails size={14} />}>Attributes</Tabs.Tab>
            <Tabs.Tab value='sharing' leftSection={<IconShare size={14} />}>Sharing</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value='general'>
            <GeneralTab path={path} stat={stat} editable={editable} refetch={refetch} />
          </Tabs.Panel>
          <Tabs.Panel value='attributes'>
            <AttributesTab path={path} stat={stat} editable={editable} refetch={refetch} />
          </Tabs.Panel>
          <Tabs.Panel value='sharing'>
            <SharePanel path={path} enabled />
          </Tabs.Panel>
        </Tabs>
      )}
    </Stack>
  );
}
