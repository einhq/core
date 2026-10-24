import { Badge, Code, Loader, Stack, Table, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { Identities } from '../../hooks/useIdentities.ts';
import type { NodeStat } from '../../hooks/useNodeStat.ts';
import { isTextLike, languageFor } from '../../lib/code-language.ts';
import { displayUrl, gridUrl, imageSrcSet, type MediaKind, posterUrl } from '../../lib/derivatives.ts';
import { fileUrl } from '../../lib/file-url.ts';
import { formatBytes, formatClock } from '../../lib/format.ts';
import { displayDims } from '../../lib/justified-layout.ts';
import { type NodeChildEntry, toMillis } from '../../lib/node-entry.ts';
import { nodeKindOf, nodeTypeLabel } from '../../lib/node-kind.ts';
import { modeString } from '../../lib/node-mode.ts';
import { baseName } from '../../lib/node-path.ts';
import { CodeMirror } from '../CodeEditor/CodeMirror.tsx';
import { CoverAvatar } from '../Cover/CoverAvatar.tsx';
import { NodeIcon } from './NodeIcon.tsx';
import { LogPreview, QueuePreview } from './NodeStreamPreview.tsx';
import { Row } from './NodeProperties.tsx';
import { formatWhen } from './NodeRow.tsx';

/** How much of a text file is shown; the rest is the code editor's. */
const TEXT_HEAD = 64 * 1024;
/** The text box's tallest, and the editor's line height at its font size. */
const TEXT_BOX = 360;
const TEXT_LINE = 18;
/**
 * Below the last line, room for the sideways scrollbar a line wider than the
 * pane brings — a minified file is one such line, and the scrollbar otherwise
 * takes the box's last line of height and lies over the text.
 */
const TEXT_SCROLLBAR = 16;
const COVERED_TYPES = new Set(['album', 'person', 'location', 'device', 'track']);

type Head = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; text: string; total: number | undefined };

/**
 * The first `TEXT_HEAD` bytes of a file, by a range request so a large log
 * costs no more than a small one. A server that ignores the range sends the
 * whole thing, which is cut here instead.
 */
function useTextHead(path: string | null): Head {
  const [head, setHead] = useState<Head>({ kind: 'loading' });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setHead({ kind: 'loading' });
    (async () => {
      const res = await fetch(fileUrl(path), { headers: { Range: `bytes=0-${TEXT_HEAD - 1}` }, signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      const bytes = new Uint8Array(await res.arrayBuffer());
      const total = Number(res.headers.get('content-range')?.split('/')[1] ?? bytes.length);
      setHead({ kind: 'ready', text: new TextDecoder().decode(bytes.subarray(0, TEXT_HEAD)), total: Number.isFinite(total) ? total : undefined });
    })().catch((err) => {
      if (!controller.signal.aborted) setHead({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    });
    return () => controller.abort();
  }, [path]);
  return head;
}

function TextPreview({ path, mimetype }: { path: string; mimetype?: string }) {
  const head = useTextHead(path);
  if (head.kind === 'loading') return <Loader size='sm' />;
  if (head.kind === 'error') return <Text size='xs' c='red'>{head.message}</Text>;
  // A short file gets a short box; a long one scrolls inside the tallest.
  const lines = head.text.split('\n').length;
  return (
    <Stack gap={4}>
      <CodeMirror value={head.text} readOnly language={languageFor(mimetype, baseName(path))} height={`${Math.min(TEXT_BOX, lines * TEXT_LINE + 10 + TEXT_SCROLLBAR)}px`} />
      {head.total !== undefined && head.total > TEXT_HEAD && (
        <Text size='xs' c='dimmed'>The first {formatBytes(TEXT_HEAD)} of {formatBytes(head.total)}; Open shows the rest.</Text>
      )}
    </Stack>
  );
}

const mediaKindOf = (mimetype = ''): MediaKind | undefined =>
  mimetype.startsWith('image/') ? 'photo' : mimetype.startsWith('video/') ? 'video' : mimetype.startsWith('audio/') ? 'audio' : undefined;

/**
 * A photo, video or audio file as the lightbox would show it, from its renditions.
 *
 * A rendition (a face crop, a thumbnail) has no `thumbnails/` of its own and
 * shows its own bytes; so does a file whose rendition fails to load, which
 * is also what a file not yet through the pipeline looks like.
 */
function MediaPreview({ path, entry, kind }: { path: string; entry: NodeChildEntry; kind: MediaKind }) {
  const { attrs } = entry.node;
  const [broken, setBroken] = useState(false);
  const [noWaveform, setNoWaveform] = useState(false);
  const hasThumbnails = attrs.sourceId === undefined && entry.childCount > 0 && !broken;
  const dims = displayDims(attrs);
  const box = { width: '100%', maxHeight: 360, objectFit: 'contain', display: 'block', borderRadius: 1 } as const;

  if (kind === 'video') {
    return (
      <video
        key={path}
        controls
        preload='metadata'
        poster={posterUrl(path, 'video', hasThumbnails, dims) || undefined}
        src={displayUrl(path, 'video', hasThumbnails)}
        onError={() => setBroken(true)}
        style={box}
      />
    );
  }
  if (kind === 'audio') {
    return (
      <Stack gap={4}>
        {hasThumbnails && !noWaveform && <img src={gridUrl(path, true)} alt='' onError={() => setNoWaveform(true)} style={box} />}
        <audio key={path} controls preload='metadata' src={displayUrl(path, 'audio', hasThumbnails)} onError={() => setBroken(true)} style={{ width: '100%' }} />
      </Stack>
    );
  }
  return (
    <img
      key={path}
      src={displayUrl(path, 'photo', hasThumbnails, dims)}
      srcSet={imageSrcSet(path, 'photo', hasThumbnails, dims) || undefined}
      sizes='360px'
      alt={entry.name}
      onError={() => setBroken(true)}
      style={box}
    />
  );
}

/** What the node holds, drawn the way its kind is best looked at. */
function Preview({ path, entry }: { path: string; entry: NodeChildEntry }) {
  const { type, attrs } = entry.node;
  const kind = nodeKindOf(entry);
  const Icon = kind.icon;

  if (type === 'log') return <LogPreview path={path} />;
  if (type === 'queue') return <QueuePreview path={path} />;

  if (type === 'file') {
    const media = mediaKindOf(attrs.mimetype);
    if (media) return <MediaPreview path={path} entry={entry} kind={media} />;
    if (isTextLike(attrs.mimetype, entry.name)) return <TextPreview path={path} mimetype={attrs.mimetype} />;
    if (attrs.mimetype === 'application/pdf') {
      return (
        <iframe
          key={path}
          src={fileUrl(path)}
          title={entry.name}
          style={{ width: '100%', height: 480, border: '1px solid var(--mrx-hairline)', borderRadius: 'var(--mantine-radius-sm)' }}
        />
      );
    }
  }

  const title = typeof attrs.name === 'string' && attrs.name !== entry.name ? attrs.name : undefined;
  return (
    <Stack gap='xs' align='center' py='sm'>
      {COVERED_TYPES.has(type)
        ? <CoverAvatar key={path} path={path} size={160} radius={1} color={kind.color} eager fallback={<Icon size={72} stroke={1.25} />} />
        : <NodeIcon entry={entry} path={path} size={96} />}
      {title && <Text size='sm' fw={600} ta='center'>{title}</Text>}
      {typeof attrs.description === 'string' && attrs.description && <Text size='xs' c='dimmed' ta='center' lineClamp={6}>{attrs.description}</Text>}
      {entry.childCount >= 0 && <Text size='xs' c='dimmed'>{entry.childCount === 1 ? '1 child' : `${entry.childCount} children`}</Text>}
    </Stack>
  );
}

type NodePreviewProps = {
  path: string;
  entry: NodeChildEntry | undefined;
  /** `stat -L` of the node, once it has come. */
  stat: NodeStat | null;
  names: Identities;
};

/**
 * The Preview tool: what the node holds, and the facts about it that the
 * details view has no room for.
 *
 * Read-only on purpose. Mode, owner, attributes and sharing are edited in the
 * properties dialog, which the tool pane's subject line opens; a second editor
 * for them in a narrow column would only disagree with it.
 */
export function NodePreview({ path, entry, stat, names }: NodePreviewProps) {
  const node = stat?.node ?? entry?.node;
  const props = node?.props;
  const attrs = (stat?.node.attrs ?? entry?.node.attrs ?? {}) as NodeChildEntry['node']['attrs'];
  const who = (uid: number) => names.users.get(uid) ?? uid;

  return (
    <Stack gap='sm'>
      {entry && <Preview key={path} path={path} entry={entry} />}
      {node && props && (
        <Table verticalSpacing={2} withRowBorders={false} layout='fixed'>
          <Table.Tbody>
            <Row label='Type'>
              <Badge size='sm' variant='light'>{node.type}</Badge>
              {props.tier && <Badge size='sm' variant='outline' color='gray' ml={4}>{props.tier}</Badge>}
            </Row>
            {entry && nodeTypeLabel(entry) !== node.type && <Row label='Mimetype'>{nodeTypeLabel(entry)}</Row>}
            {typeof attrs.size === 'number' && <Row label='Size'>{formatBytes(attrs.size)}</Row>}
            {!!attrs.width && !!attrs.height && <Row label='Dimensions'>{attrs.width} × {attrs.height}</Row>}
            {typeof attrs.duration === 'number' && <Row label='Duration'>{formatClock(attrs.duration)}</Row>}
            <Row label='Mode'>
              <Text span size='xs' ff='monospace'>{modeString(props.mode)}</Text>
            </Row>
            <Row label='Owner'>{who(props.uid)}</Row>
            <Row label='Group'>{names.groups.get(props.gid) ?? props.gid}</Row>
            <Row label='Modified'>
              {formatWhen(toMillis(props.modtime.timestamp))} <Text span size='xs' c='dimmed'>by {who(props.modtime.uid)}</Text>
            </Row>
            <Row label='Created'>{formatWhen(toMillis(props.birthtime.timestamp))}</Row>
            {props.softlink && (
              <Row label='Link to'>
                <Code>{props.softlink}</Code>
              </Row>
            )}
            {Array.isArray(attrs.labels) && attrs.labels.length > 0 && <Row label='Labels'>{attrs.labels.join(', ')}</Row>}
            <Row label='Id'>
              <Code>{node.id}</Code>
            </Row>
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
