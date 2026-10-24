import { Box, Button, Flex, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { IconLinkOff, IconLogin2 } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { HatField } from '../components/EntityDetail/HatField.tsx';
import { EinMark } from '../components/Layout/EinMark.tsx';
import { loadUiManifest, openRoute } from '../signals/module-ui.ts';
import { openShareLink } from '../signals/user.ts';

/**
 * `/s/<token>`: where a share link lands. It opens the link for this browser and loads the page of
 * what it opens afresh, so that page is read with the link held; a link that no longer opens
 * anything says so, and offers signing in to whoever has an account.
 *
 * Drawn outside the frame, like the sign-in page, because the visitor may have nothing else to see.
 */
export default function SharedLinkPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opened = await openShareLink(token);
        // Which page shows a node is the modules' to say, in the manifest.
        await loadUiManifest();
        if (!cancelled) globalThis.location.replace(openRoute(opened.type, opened.path) ?? '/');
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <Flex className='mrx-pattern' data-pattern='mixed' h='100vh' w='100vw' justify='center' align='center' p='xl'>
      <Box pos='absolute' inset={0}>
        <HatField pattern='mixed' kind='backdrop' />
      </Box>
      <Paper withBorder p='xl' radius='md' w='100%' maw={420}>
        <Stack gap='xl'>
          <Group gap={10} wrap='nowrap'>
            <EinMark size={32} />
            <Title order={1} size='h2' fw={700} c='marine.5' style={{ fontFamily: '"Mochiy Pop One", sans-serif' }}>
              EiN
            </Title>
          </Group>

          {failed
            ? (
              <Stack gap='md'>
                <Group gap='xs' wrap='nowrap'>
                  <IconLinkOff size={22} />
                  <Title order={2} size='h4'>This link no longer works</Title>
                </Group>
                <Text size='sm' c='dimmed'>
                  It may have expired, or the person who shared it has turned it off. Ask them to send you a new link.
                </Text>
                <Button variant='light' leftSection={<IconLogin2 size={16} />} onClick={() => navigate('/login')}>
                  Sign in
                </Button>
              </Stack>
            )
            : (
              <Group gap='sm' wrap='nowrap'>
                <Loader size='sm' />
                <Text>Opening what was shared with you…</Text>
              </Group>
            )}
        </Stack>
      </Paper>
    </Flex>
  );
}
