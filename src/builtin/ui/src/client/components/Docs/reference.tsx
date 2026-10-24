import { Anchor, Badge, Box, Stack, Text, Title } from '@mantine/core';
import { IconAdjustments, IconBinaryTree, IconPuzzle, IconTerminal2, IconVariable } from '@tabler/icons-react';
import { type ReactNode, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';

/** A guide page, by its VFS path. */
export const docRoute = (path: string): string => `/docs/${encodeURIComponent(path)}`;
export const commandAnchor = (name: string): string => `cmd-${name}`;
export const commandRoute = (name: string): string => `/docs/commands#${commandAnchor(name)}`;
export const moduleRoute = (name: string): string => `/docs/modules/${encodeURIComponent(name)}`;
export const settingAnchor = (key: string): string => `set-${key}`;
export const envAnchor = (kind: string, key: string): string => `env-${kind}-${key}`;
export const nodeTypeAnchor = (type: string): string => `type-${type}`;

/** The pages generated from the running installation rather than written. */
export const REFERENCE_PAGES = [
  { slug: 'commands', label: 'Commands', icon: IconTerminal2, what: 'Every command on your PATH' },
  { slug: 'settings', label: 'Settings', icon: IconAdjustments, what: 'Every setting, with its current value' },
  { slug: 'environment', label: 'Environment', icon: IconVariable, what: 'The environment variables EiN reads' },
  { slug: 'node-types', label: 'Node types', icon: IconBinaryTree, what: 'What the tree is made of' },
  { slug: 'modules', label: 'Modules', icon: IconPuzzle, what: 'What is installed' },
] as const;

/**
 * Scroll to the entry the URL's hash names once it exists, and mark it.
 *
 * The browser scrolls to a hash when the page loads, before a reference page has its data, and
 * `:target` is decided then too; so both are done here once `ready`, and again when only the
 * hash changes.
 */
export function useScrollToHash(ready: boolean) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || !hash) return;
    const element = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!element) return;
    element.scrollIntoView({ block: 'start', behavior: 'smooth' });
    element.setAttribute('data-targeted', '');
    const timer = setTimeout(() => element.removeAttribute('data-targeted'), 2500);
    return () => {
      clearTimeout(timer);
      element.removeAttribute('data-targeted');
    };
  }, [ready, hash]);
}

/**
 * A description as its author wrote it, with `backticked` words as code. Specs, settings and
 * `mod.json` entries are written for a terminal as much as for this page; the backticks are the
 * one piece of markup they carry.
 */
export function DescriptionText({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <code key={i} className='mrx-code mrx-code-inline'>{part.slice(1, -1)}</code> : part
      )}
    </>
  );
}

/** Who provides a thing: core, or a module, linked to that module's page. */
export function OwnerBadge({ owner }: { owner?: string }) {
  if (!owner || owner === 'core') {
    return <Badge variant='default' size='sm' radius='sm' tt='none'>core</Badge>;
  }
  return (
    <Badge component={Link} to={moduleRoute(owner)} variant='light' color='violet' size='sm' radius='sm' tt='none' style={{ cursor: 'pointer' }}>
      {owner}
    </Badge>
  );
}

/** The heading and lead paragraph every reference page starts with. */
export function ReferenceIntro({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <Stack gap='xs' mb='lg'>
      <Title order={1} fz={28}>{title}</Title>
      <Text c='dimmed' maw={720}>{children}</Text>
      {aside}
    </Stack>
  );
}

/** A heading inside a reference page, linkable by its id. */
export function ReferenceSection({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <Box component='section' id={id} mb='xl' className='mrx-docs-target'>
      <Title order={2} fz='xl' mb={4}>
        <Anchor href={`#${id}`} c='inherit' underline='never'>{title}</Anchor>
      </Title>
      {intro && <Text c='dimmed' size='sm' mb='sm' maw={720}>{intro}</Text>}
      {children}
    </Box>
  );
}
