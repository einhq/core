import { Box, Button, CloseButton, Collapse, Container, Flex, Text, TextInput } from '@mantine/core';
import { IconList, IconSearch } from '@tabler/icons-react';
import { DOCS_GUIDE_PATH } from '@ein/paths';
import { DocsSearch, DocsSidebar, DocView, EntityDetailHeader, HeaderFilterBar, ModuleDetail } from '@ein/ui/components';
import { useDocs } from '@ein/ui/hooks';
import { type ReactNode, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

const FIND_PARAM = 'find';

/**
 * The docs section: the header every page has, with a search over all of the documentation; the
 * contents on the left — folded behind a button on a phone — and the page on the right. While
 * something is typed in the search the results stand in for the page, and the query is in the URL
 * so a search can be linked and Back returns to it.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  const { tree, loading } = useDocs(DOCS_GUIDE_PATH);
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

  const sidebar = <DocsSidebar tree={tree} loading={loading} indexPath={`${DOCS_GUIDE_PATH}/index.md`} onNavigate={() => setContentsOpen(false)} />;

  return (
    <Box>
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
            {query.trim() ? <DocsSearch query={query} guide={tree} /> : children}
          </Box>
        </Flex>
      </Container>
    </Box>
  );
}

/** Docs landing: the guide's overview. */
export function DocsIndexPage() {
  return <DocView path={`${DOCS_GUIDE_PATH}/index.md`} />;
}

/** The doc addressed by the encoded VFS path in the route. */
export function DocPage() {
  const { id } = useParams();
  const path = id ? decodeURIComponent(id) : `${DOCS_GUIDE_PATH}/index.md`;
  return <DocView path={path} />;
}

/** One installed module and everything it brings. */
export function ModulePage() {
  const { name = '' } = useParams();
  return <ModuleDetail name={decodeURIComponent(name)} />;
}
