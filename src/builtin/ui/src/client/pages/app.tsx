import { Anchor, Button, Card, Container, Group, Stack, Table, Text } from '@mantine/core';
import { IconPlugConnectedX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState/EmptyState.tsx';
import { EntityDetailHeader } from '../components/EntityDetail/EntityDetailHeader.tsx';
import { AppBackup } from '../components/App/AppBackup.tsx';
import { AppTracking } from '../components/App/AppTracking.tsx';
import { PageLoader } from '../components/Layout/PageLoader.tsx';
import { appInfo, appUnpair, type EinAppInfo, inEinApp } from '../lib/ein-app.ts';
import { notify } from '../signals/notify.ts';

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * The EiN app's own page (`/app`, the sidebar's `ui.app`, which only the app shows): the EiN and the
 * phone it is paired with, the account it signs in as, its version, and unpairing it, which the app
 * does with its own token and then shows its pairing screen; below, the phone's photo backup
 * (`AppBackup`) and its position reports (`AppTracking`). A browser that opens the address is told the page is the app's.
 */
export default function AppPage() {
  const [info, setInfo] = useState<EinAppInfo>();
  const [failed, setFailed] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [unpairing, setUnpairing] = useState(false);

  useEffect(() => {
    if (inEinApp()) appInfo().then(setInfo, (error) => setFailed(messageOf(error)));
  }, []);

  const unpair = async () => {
    setUnpairing(true);
    try {
      await appUnpair();
    } catch (error) {
      notify({ message: messageOf(error), color: 'red' });
      setUnpairing(false);
    }
  };

  const header = (
    <EntityDetailHeader
      title='App'
      pattern='mixed'
      subtitle={<Text size='sm' c='gray.2'>The EiN app on this phone</Text>}
    />
  );

  if (!inEinApp()) {
    return (
      <>
        {header}
        <EmptyState title='This page is the EiN app’s'>Open it in the EiN app on a phone paired with this EiN.</EmptyState>
      </>
    );
  }
  if (failed) {
    return (
      <>
        {header}
        <EmptyState title='The app did not answer'>{failed}</EmptyState>
      </>
    );
  }
  if (!info) return <PageLoader />;

  return (
    <>
      {header}
      <Container py='md' px='md'>
        <Stack gap='md'>
          <Card withBorder maw={560}>
            <Stack gap='md'>
              <Table withRowBorders={false} verticalSpacing={4} horizontalSpacing={0}>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Th w={140} fw={500} c='dimmed'>Paired with</Table.Th>
                    <Table.Td>{info.server}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th fw={500} c='dimmed'>This phone</Table.Th>
                    <Table.Td>
                      <Anchor component={Link} to={`/devices/${encodeURIComponent(info.device)}`}>{info.device}</Anchor>
                    </Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th fw={500} c='dimmed'>Signed in as</Table.Th>
                    <Table.Td>{info.user}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th fw={500} c='dimmed'>App version</Table.Th>
                    <Table.Td>{info.version}</Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
              <Group gap='xs'>
                {confirming
                  ? (
                    <>
                      <Text size='sm'>The app is signed out and asks for a new QR code.</Text>
                      <Button size='xs' color='red' loading={unpairing} onClick={() => void unpair()}>Unpair</Button>
                      <Button size='xs' variant='default' disabled={unpairing} onClick={() => setConfirming(false)}>Cancel</Button>
                    </>
                  )
                  : (
                    <Button size='xs' variant='default' color='red' leftSection={<IconPlugConnectedX size={14} />} onClick={() => setConfirming(true)}>
                      Unpair
                    </Button>
                  )}
              </Group>
            </Stack>
          </Card>
          <AppBackup />
          <AppTracking device={info.device} />
        </Stack>
      </Container>
    </>
  );
}
