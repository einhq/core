import { Alert, Container, Stack, Tabs, Text } from '@mantine/core';
import { IconAdjustments, IconAlertTriangle, IconPuzzle, IconShieldLock, IconUser, IconUsersGroup } from '@tabler/icons-react';
import { useSearchParams } from 'react-router-dom';
import { EntityDetailHeader, PageLoader, SettingsForm } from '@ein/ui/components';
import { useAccessIds, useConfig } from '@ein/ui/hooks';
import { AccountDefaults } from '../components/Settings/Accounts/AccountDefaults.tsx';
import { AccountsTab } from '../components/Settings/Accounts/AccountsTab.tsx';
import { ModulesTab } from '../components/Settings/Modules/ModulesTab.tsx';

const TABS = ['system', 'users', 'groups', 'permissions', 'modules'] as const;
type SettingsTab = typeof TABS[number];

/** The tabs only an administrator is shown. */
const ADMIN_TABS: ReadonlySet<SettingsTab> = new Set(['system', 'users', 'groups', 'permissions']);

const isTab = (value: string | null): value is SettingsTab => value !== null && (TABS as readonly string[]).includes(value);

/**
 * How the installation is configured: its settings, its users and groups, the permissions new
 * accounts and anything shared start with, and the modules it is made of.
 *
 * All but Modules are an administrator's alone, so for anyone else those tabs are
 * hidden rather than disabled — there is nothing on them anyone else can act on, and the server
 * refuses the writes regardless of what the browser draws — and the page opens on Modules instead.
 * The tab lives in the URL so a view can be linked to directly. Users and Groups are one
 * `AccountsTab`, kept mounted while either is shown, so moving between them reloads nothing;
 * Modules is laid out as they are, a list beside the open module.
 */
export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const access = useAccessIds();
  const isAdmin = access?.admin === true;
  const fallback: SettingsTab = isAdmin ? 'system' : 'modules';
  const requested = searchParams.get('tab');
  const tab: SettingsTab = isTab(requested) && (!ADMIN_TABS.has(requested) || isAdmin) ? requested : fallback;

  // One table for the tabs that show system settings, so a change saved in one shows in the other.
  const config = useConfig('system');

  return (
    <Tabs
      value={tab}
      onChange={(value) => setSearchParams(value && value !== fallback ? { tab: value } : {}, { replace: true })}
      keepMounted={false}
    >
      <EntityDetailHeader
        title='Settings'
        tabs={
          <Tabs.List>
            {isAdmin && <Tabs.Tab value='system' leftSection={<IconAdjustments size={16} />}>System</Tabs.Tab>}
            {isAdmin && <Tabs.Tab value='users' leftSection={<IconUser size={16} />}>Users</Tabs.Tab>}
            {isAdmin && <Tabs.Tab value='groups' leftSection={<IconUsersGroup size={16} />}>Groups</Tabs.Tab>}
            {isAdmin && <Tabs.Tab value='permissions' leftSection={<IconShieldLock size={16} />}>Permissions</Tabs.Tab>}
            <Tabs.Tab value='modules' leftSection={<IconPuzzle size={16} />}>Modules</Tabs.Tab>
          </Tabs.List>
        }
        pattern='mixed'
        subtitle={
          <Text size='sm' c='gray.2'>
            How this installation is configured, and what it is made of
          </Text>
        }
        flowContent
      />

      <Container px='md' py='lg'>
        {isAdmin && (
          <Tabs.Panel value='system'>
            <Stack gap='lg'>
              <Text c='dimmed'>
                Settings for the whole installation. A change takes effect without a restart of EiN: a service that reads it only when it starts is restarted, and everything
                else uses it from its next command on.
              </Text>
              {config.error && (
                <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />}>
                  {config.error.message}
                </Alert>
              )}
              {config.loading ? <PageLoader label='Loading settings…' /> : <SettingsForm entries={config.entries} save={config.save} reset={config.reset} />}
            </Stack>
          </Tabs.Panel>
        )}

        {isAdmin && (tab === 'users' || tab === 'groups') && <AccountsTab view={tab} />}

        {isAdmin && (
          <Tabs.Panel value='permissions'>
            <AccountDefaults config={config} />
          </Tabs.Panel>
        )}

        <Tabs.Panel value='modules'>
          <ModulesTab />
        </Tabs.Panel>
      </Container>
    </Tabs>
  );
}
