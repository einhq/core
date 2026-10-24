import { Anchor, Badge, Box, Center, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { type DocNode, useCommandFind, useCommandReference, useConfig, useEnvReference, useModuleReference, useNodeTypeReference } from '@ein/ui/hooks';
import { foldText, queryWords, textScore } from '@ein/ui/lib';
import { fileUrl } from '../../lib/file-url.ts';
import { displayNames, EffectBadge } from './CommandReference.tsx';
import { prettify } from './DocsSidebar.tsx';
import { commandRoute, docRoute, envAnchor, moduleRoute, nodeTypeAnchor, OwnerBadge, settingAnchor } from './reference.tsx';

const LIMIT = 12;
/** A `find` score below this is the model guessing: see where it is used. */
const FIND_FLOOR = 0.45;

type Result = { key: string; score: number; to: string; title: ReactNode; badges?: ReactNode; text?: string };

/** The guide's text, fetched once per page load: a handful of small files, searched as they are. */
let guideText: Promise<{ path: string; title: string; text: string }[]> | undefined;

const loadGuide = (tree: DocNode[]) => {
  const files: DocNode[] = [];
  const walk = (nodes: DocNode[]) => nodes.forEach((node) => node.type === 'directory' ? walk(node.children ?? []) : files.push(node));
  walk(tree);
  return Promise.all(files.map(async (file) => {
    const res = await fetch(fileUrl(file.path));
    const text = res.ok ? await res.text() : '';
    return { path: file.path, title: text.match(/^#\s+(.+)$/m)?.[1] ?? prettify(file.name), text };
  }));
};

/** The line of `text` that best shows why it matched, trimmed of markdown. */
const snippet = (text: string, query: string): string | undefined => {
  const words = queryWords(query);
  const line = text.split('\n').find((candidate) => !candidate.startsWith('#') && words.some((word) => foldText(candidate).includes(word)));
  return line?.replace(/[*_`[\]]|\(([^)]*)\)/g, '').trim();
};

function ResultList({ title, results, loading }: { title: string; results: Result[]; loading?: boolean }) {
  if (!results.length && !loading) return null;
  return (
    <Box>
      <Group gap='xs' mb={6}>
        <Title order={2} fz='md'>{title}</Title>
        {loading && <Loader size='xs' />}
      </Group>
      <Stack gap={10}>
        {results.map((result) => (
          <Box key={result.key}>
            <Group gap='xs' wrap='wrap'>
              <Anchor component={Link} to={result.to} fw={500}>{result.title}</Anchor>
              {result.badges}
            </Group>
            {result.text && <Text size='sm' c='dimmed' lineClamp={2}>{result.text}</Text>}
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

const best = (results: Result[]): Result[] => results.filter((result) => result.score > 0).sort((a, b) => b.score - a.score).slice(0, LIMIT);

/**
 * Everything the documentation knows, searched at once: commands by what they do (the assistant's
 * index, by meaning and by words) and by name, settings, variables, node types, modules and the
 * guide's own text.
 */
export function DocsSearch({ query, guide }: { query: string; guide: DocNode[] }) {
  const { data: commands, loading: commandsLoading } = useCommandReference();
  const { data: hits, loading: hitsLoading } = useCommandFind(query);
  const { entries: settings } = useConfig();
  const { data: env } = useEnvReference();
  const { data: types } = useNodeTypeReference();
  const { data: modules } = useModuleReference();
  const [pages, setPages] = useState<{ path: string; title: string; text: string }[]>([]);

  useEffect(() => {
    if (!guide.length) return;
    guideText ??= loadGuide(guide).catch(() => {
      guideText = undefined;
      return [];
    });
    guideText.then(setPages);
  }, [guide]);

  const names = useMemo(() => displayNames(commands ?? []), [commands]);

  const commandResults = useMemo(() => {
    // The index knows what the words mean — "restart a service" is `service restart` — and counts in
    // proportion to how sure it is. A real question scores its best hit well above FIND_FLOOR, a
    // string of letters like `albstk` stays below it for everything, so below the floor a hit is
    // noise and the letters-in-order match on the name decides.
    const found = new Map((hits ?? []).filter((hit) => hit.score >= FIND_FLOOR).map((hit) => [hit.name, hit.score * 10]));
    return best((commands ?? []).map((entry) => {
      const { spec } = entry;
      const local = textScore(names.get(entry.name) ?? entry.name, [
        spec.description,
        spec.returns,
        ...(spec.examples ?? []),
        ...(spec.flags ?? []).map((flag) => `${flag.name} ${flag.description}`),
      ], query);
      return {
        key: entry.name,
        score: local + (found.get(entry.name) ?? 0),
        to: commandRoute(entry.name),
        title: <Text span ff='monospace' fw={500}>{names.get(entry.name)}</Text>,
        badges: (
          <>
            <OwnerBadge owner={entry.module} />
            <EffectBadge effect={spec.effect} />
          </>
        ),
        text: spec.description,
      };
    }));
  }, [commands, hits, names, query]);

  const settingResults = useMemo(() =>
    best(settings.map((entry) => ({
      key: entry.key,
      score: Math.max(textScore(entry.label, [entry.description, entry.group], query), textScore(entry.key, [], query)),
      to: `/docs/settings#${settingAnchor(entry.key)}`,
      title: entry.label,
      badges: <Text span size='xs' c='dimmed' ff='monospace'>{entry.key}</Text>,
      text: entry.description,
    }))), [settings, query]);

  const envResults = useMemo(() =>
    best((env ?? []).map((entry) => ({
      key: `${entry.kind}:${entry.key}`,
      score: textScore(entry.key, [entry.description], query),
      to: `/docs/environment#${envAnchor(entry.kind, entry.key)}`,
      title: <Text span ff='monospace' fw={500}>{entry.key}</Text>,
      badges: <Badge size='xs' radius='sm' variant='default' tt='none'>{entry.kind}</Badge>,
      text: entry.description,
    }))), [env, query]);

  const typeResults = useMemo(() =>
    best((types ?? []).map((entry) => ({
      key: entry.type,
      score: Math.max(textScore(entry.label ?? entry.type, [entry.description], query), textScore(entry.type, [], query)),
      to: `/docs/node-types#${nodeTypeAnchor(entry.type)}`,
      title: entry.label ?? entry.type,
      badges: <Text span size='xs' c='dimmed' ff='monospace'>{entry.type}</Text>,
      text: entry.description,
    }))), [types, query]);

  const moduleResults = useMemo(() =>
    best((modules ?? []).map((entry) => ({
      key: entry.name,
      score: textScore(entry.name, [entry.description], query),
      to: moduleRoute(entry.name),
      title: entry.name,
      text: entry.description,
    }))), [modules, query]);

  const guideResults = useMemo(() =>
    best(pages.map((page) => ({
      key: page.path,
      score: textScore(page.title, [page.text], query),
      to: docRoute(page.path),
      title: page.title,
      text: snippet(page.text, query),
    }))), [pages, query]);

  const lists = [
    { title: 'Commands', results: commandResults, loading: (commandsLoading && !commands) || hitsLoading },
    { title: 'Guide', results: guideResults },
    { title: 'Settings', results: settingResults },
    { title: 'Environment', results: envResults },
    { title: 'Node types', results: typeResults },
    { title: 'Modules', results: moduleResults },
  ];
  const nothing = lists.every((list) => !list.results.length && !list.loading);

  return (
    <Stack gap='xl'>
      <Text c='dimmed' size='sm'>
        Results for <Text span fw={600} c='var(--mantine-color-text)'>{query}</Text>
      </Text>
      {nothing
        ? (
          <Center py='xl'>
            <Text c='dimmed'>Nothing in the documentation matches that.</Text>
          </Center>
        )
        : lists.map((list) => <ResultList key={list.title} {...list} />)}
    </Stack>
  );
}
