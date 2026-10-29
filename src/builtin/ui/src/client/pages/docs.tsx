import { Anchor, Box, Button, CloseButton, Collapse, Container, Flex, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconList, IconSearch } from '@tabler/icons-react';
import { DOCS_GUIDE_PATH } from '@ein/paths';
import { DocsSearch, DocsSidebar, DocView, EntityDetailHeader, HeaderFilterBar, ModuleDetail } from '@ein/ui/components';
import { useGuide } from '@ein/ui/hooks';
import { type ReactNode, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { PageLoader } from '../components/Layout/PageLoader.tsx';
import { fileUrl } from '../lib/file-url.ts';
import { GUIDE_SITE, guidePageOf } from '../lib/guide.ts';

const FIND_PARAM = 'find';

/** The fonts the guide's diagrams are drawn in, from the bundle, so an inline diagram lays out as on the site. */
const GUIDE_FONTS = [
  ['Familjen Grotesk', 'familjen-grotesk', '400 700'],
  ['Fragment Mono', 'fragment-mono', '400'],
].map(([family, file, weight]) =>
  ['latin', 'latin-ext'].map((subset) =>
    `@font-face { font-family: '${family}'; font-weight: ${weight}; font-display: swap; src: url(${
      fileUrl(`${DOCS_GUIDE_PATH}/assets/fonts/${file}-${subset}.woff2`)
    }) format('woff2'); }`
  ).join('\n')
).join('\n');

/**
 * The docs section: the header every page has, with a search over all of the documentation; the
 * contents on the left — folded behind a button on a phone — and the page on the right. While
 * something is typed in the search the results stand in for the page, and the query is in the URL
 * so a search can be linked and Back returns to it.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  const { guide, loading } = useGuide();
  const [searchParams, setSearchParams] = useSearchParams();
  const [contentsOpen, setContentsOpen] = useState(false);
  // Not `q`: the app header's own search box reads that on every route, and would show this one's words.
  const query = searchParams.get(FIND_PARAM) ?? '';

  const setQuery = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(FIND_PARAM, value);
    else next.delete(FIND_PARAM);
    setSearchParams(next, { replace: true });
  };

  const sidebar = <DocsSidebar guide={guide} loading={loading} onNavigate={() => setContentsOpen(false)} />;

  return (
    <Box>
      {guide && <style>{GUIDE_FONTS}</style>}
      <EntityDetailHeader
        title='Documentation'
        pattern='mixed'
        subtitle={
          <Text size='sm' c='gray.2'>
            How it works, and the commands, settings and modules installed here
          </Text>
        }
        flowContent
        controls={
          <HeaderFilterBar
            wide
            input={
              <TextInput
                placeholder='Search commands, settings, guides…'
                aria-label='Search the documentation'
                leftSection={<IconSearch size={16} />}
                rightSection={query ? <CloseButton size='sm' aria-label='Clear the search' onClick={() => setQuery('')} /> : undefined}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                size='md'
                style={{ flex: 1 }}
              />
            }
          >
            {null}
          </HeaderFilterBar>
        }
      />

      {
        /* The spacing below the header is inside the contents and the page rather than on the
          container, so the contents' scroll box — and its scrollbar — starts right at the header,
          and sticks right under the header's row stuck below the app's own. */
      }
      <Container size='xl' px='md'>
        <Button
          hiddenFrom='sm'
          variant='light'
          size='xs'
          leftSection={<IconList size={16} />}
          onClick={() => setContentsOpen((open) => !open)}
          mt='lg'
        >
          Contents
        </Button>
        <Collapse expanded={contentsOpen} hiddenFrom='sm' mt='sm'>
          {sidebar}
        </Collapse>

        <Flex align='flex-start' gap='xl'>
          <Box
            visibleFrom='sm'
            w={240}
            py='lg'
            style={{
              flexShrink: 0,
              position: 'sticky',
              top: 'calc(var(--app-shell-header-height, 0px) + var(--mrx-stuck-header-height, 0px))',
              alignSelf: 'flex-start',
              maxHeight: 'calc(100dvh - var(--app-shell-header-height, 0px) - var(--mrx-stuck-header-height, 0px))',
              overflowY: 'auto',
            }}
          >
            {sidebar}
          </Box>
          <Box py='lg' style={{ flex: 1, minWidth: 0 }}>
            {query.trim() ? <DocsSearch query={query} guide={guide} /> : children}
          </Box>
        </Flex>
      </Container>
    </Box>
  );
}

/** Without a guide bundled, the landing points at the published one and at what this installation draws itself. */
function NoGuide() {
  return (
    <Stack gap='sm' maw={720}>
      <Title order={1} fz={28}>Documentation</Title>
      <Text>
        The guide to EiN is at <Anchor href={GUIDE_SITE} target='_blank' rel='noreferrer'>einhq.eu/docs</Anchor>; this installation has no copy of its own.
      </Text>
      <Text>
        What is installed here is described on the pages beside this one: the <Anchor component={Link} to='/docs/commands'>commands</Anchor>,{' '}
        <Anchor component={Link} to='/docs/settings'>settings</Anchor>, <Anchor component={Link} to='/docs/environment'>environment</Anchor>,{' '}
        <Anchor component={Link} to='/docs/node-types'>node types</Anchor> and <Anchor component={Link} to='/docs/modules'>modules</Anchor>.
      </Text>
    </Stack>
  );
}

/** A page of the guide, by its route (`/docs/shell/ssh-sftp`); `/docs` itself is the welcome page. */
export function DocPage() {
  const { '*': route = '' } = useParams();
  const { guide, loading } = useGuide();
  if (loading) return <PageLoader />;
  if (!guide) return <NoGuide />;
  return <DocView page={guidePageOf(guide, route.replace(/\/+$/, ''))} />;
}

/** One installed module and everything it brings. */
export function ModulePage() {
  const { name = '' } = useParams();
  return <ModuleDetail name={decodeURIComponent(name)} />;
}
