import { Anchor, Box, Center, List, Text, Title } from '@mantine/core';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { useSignals } from '@preact/signals-react/runtime';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { execCommand } from '../../signals/shell-client.ts';
import { currentUser } from '../../signals/user.ts';
import { shq } from '../../lib/shquote.ts';
import { fileUrl } from '../../lib/file-url.ts';
import { type NodeChildEntry } from '../../lib/node-entry.ts';
import { prettify } from './DocsSidebar.tsx';
import { Markdown } from '../Markdown/Markdown.tsx';

/** A URL with an explicit scheme (http:, mailto:, …) or protocol-relative. */
const isExternal = (url: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');

/** Resolve a link against an absolute VFS directory (posix-style); an absolute one stands alone. */
const resolveVfsPath = (baseDir: string, rel: string): string => {
  const [pathPart] = rel.split(/[?#]/);
  const stack = rel.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
  for (const seg of pathPart.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return '/' + stack.join('/');
};

/**
 * A doc's links: to another doc within `/docs`, relative to the doc's directory; any other
 * absolute link is a page of the app (`/docs/commands`, `/profile?tab=preferences`); a web
 * address opens in a new tab.
 */
const docLink = (baseDir: string) => (href: string): string | undefined => {
  if (isExternal(href)) return undefined;
  if (href.startsWith('/') && !/\.md([?#]|$)/i.test(href)) return href;
  return `/docs/${encodeURIComponent(resolveVfsPath(baseDir, href))}`;
};

/** A doc's images: relative ones from the doc's directory, through `/file`. */
const docImage = (baseDir: string) => (src: string): string => isExternal(src) ? src : fileUrl(resolveVfsPath(baseDir, src));

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

type Loaded =
  | { kind: 'markdown'; content: string; baseDir: string }
  | { kind: 'listing'; entries: { name: string; path: string }[] };

async function loadDoc(path: string): Promise<Loaded> {
  if (path.toLowerCase().endsWith('.md')) {
    const res = await fetch(fileUrl(path));
    if (!res.ok) throw new Error(`could not load ${path} (${res.status})`);
    return { kind: 'markdown', content: await res.text(), baseDir: dirOf(path) };
  }

  // Directory: prefer an index.md, otherwise list the child docs.
  const entries = await execCommand<NodeChildEntry[]>(`ls -l ${shq(path)}`);
  const hasIndex = entries.some((e) => e.name.toLowerCase() === 'index.md');
  if (hasIndex) {
    const indexPath = `${path}/index.md`;
    const res = await fetch(fileUrl(indexPath));
    if (res.ok) {
      return { kind: 'markdown', content: await res.text(), baseDir: path };
    }
  }

  const docs = entries
    .filter((e) => e.node.type === 'directory' || e.node.type === 'softlink' || e.name.toLowerCase().endsWith('.md'))
    .map((e) => ({ name: e.name, path: `${path}/${e.name}` }));
  return { kind: 'listing', entries: docs };
}

let sshPort: Promise<string | undefined> | undefined;

/**
 * What `{{…}}` in a doc stands for on this installation: the host the reader reached it at, the
 * SSH port it listens on, the reader's own name. A doc says `ssh -p {{ssh.port}} {{user}}@{{host}}`
 * and the reader copies a line that works; a name nobody knows is left as written.
 */
function useDocVariables(): Record<string, string> {
  useSignals();
  const [port, setPort] = useState<string>();
  useEffect(() => {
    sshPort ??= execCommand<{ value: string }>('config get CFG_SSH_PORT').then((entry) => entry?.value || undefined).catch(() => {
      sshPort = undefined;
      return undefined;
    });
    let cancelled = false;
    sshPort.then((value) => !cancelled && setPort(value));
    return () => {
      cancelled = true;
    };
  }, []);
  const user = currentUser.value?.username;
  return useMemo(() => ({
    host: globalThis.location?.hostname ?? '',
    origin: globalThis.location?.origin ?? '',
    ...(port ? { 'ssh.port': port } : {}),
    ...(user ? { user } : {}),
  }), [port, user]);
}

const fill = (content: string, variables: Record<string, string>): string => content.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (written, name: string) => variables[name] || written);

/** Load and render the doc at a VFS path (markdown file, directory index, or listing). */
export function DocView({ path }: { path: string }) {
  const navigate = useNavigate();
  const variables = useDocVariables();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadDoc(path)
      .then((res) => !cancelled && setLoaded(res))
      .catch((err) => !cancelled && setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (loading) {
    return <PageLoader />;
  }

  if (error) {
    return (
      <Center py='xl'>
        <Text c='red'>{error.message}</Text>
      </Center>
    );
  }

  if (loaded?.kind === 'markdown') {
    return (
      <Box maw={820}>
        <Markdown content={fill(loaded.content, variables)} link={docLink(loaded.baseDir)} image={docImage(loaded.baseDir)} />
      </Box>
    );
  }

  if (loaded?.kind === 'listing') {
    return (
      <Box maw={820}>
        <Title order={2} mb='md'>{prettify(path.split('/').pop() || 'Docs')}</Title>
        {loaded.entries.length === 0 ? <Text c='dimmed'>Nothing here yet.</Text> : (
          <List spacing='xs'>
            {loaded.entries.map((e) => (
              <List.Item key={e.path}>
                <Anchor onClick={() => navigate(`/docs/${encodeURIComponent(e.path)}`)}>
                  {prettify(e.name)}
                </Anchor>
              </List.Item>
            ))}
          </List>
        )}
      </Box>
    );
  }

  return null;
}
