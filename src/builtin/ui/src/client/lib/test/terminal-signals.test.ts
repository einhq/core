import { assert, assertEquals, assertNotEquals } from '@std/assert';
import {
  activeTerminalTab,
  closeTerminalTab,
  openTerminalTab,
  parseTerminalWorkspace,
  registerTerminalTerminator,
  resetCopiedTerminalWorkspace,
  setTabConnected,
  terminalOpen,
  terminalTabExited,
  terminalTabs,
  terminalWorkspaceId,
} from '../../signals/terminal.ts';

function preserveSignals(fn: () => void): void {
  const previousTabs = terminalTabs.value;
  const previousActive = activeTerminalTab.value;
  const previousOpen = terminalOpen.value;
  const previousWorkspaceId = terminalWorkspaceId.value;
  try {
    fn();
  } finally {
    terminalTabs.value = previousTabs;
    activeTerminalTab.value = previousActive;
    terminalOpen.value = previousOpen;
    terminalWorkspaceId.value = previousWorkspaceId;
  }
}

Deno.test('terminal workspace parser restores safe session metadata only', () => {
  assertEquals(
    parseTerminalWorkspace(JSON.stringify({
      version: 1,
      open: true,
      activeTabId: 'tab-b',
      tabs: [
        { id: 'tab-a', title: 'Session 1', pwd: '/tmp', connected: true, initialCommand: 'danger' },
        { id: 'tab-b', title: 'Session 2' },
      ],
    })),
    {
      version: 1,
      open: true,
      activeTabId: 'tab-b',
      tabs: [
        { id: 'tab-a', title: 'Session 1', pwd: '/tmp' },
        { id: 'tab-b', title: 'Session 2' },
      ],
    },
  );
  assertEquals(parseTerminalWorkspace('{broken'), undefined);
  assertEquals(parseTerminalWorkspace(JSON.stringify({ version: 1, open: true, activeTabId: 'x', tabs: [] })), undefined);
  assertEquals(
    parseTerminalWorkspace(JSON.stringify({ version: 1, open: false, activeTabId: 'missing', tabs: [{ id: 'tab-a', title: 'A' }] }))?.activeTabId,
    'tab-a',
  );
});

Deno.test('openTerminalTab opens and activates a fresh tab with a startup command', () => {
  preserveSignals(() => {
    terminalOpen.value = false;
    const id = openTerminalTab(`cd '/archive/albums/trip'`);
    assertEquals(terminalOpen.value, true);
    assertEquals(activeTerminalTab.value, id);
    assertEquals(terminalTabs.value.at(-1)?.initialCommand, `cd '/archive/albums/trip'`);
  });
});

Deno.test('transient disconnect retains a tab and explicit close terminates it', () => {
  preserveSignals(() => {
    const firstId = terminalTabs.value[0].id;
    const secondId = openTerminalTab();
    let terminated = false;
    const unregister = registerTerminalTerminator(secondId, () => terminated = true);
    try {
      setTabConnected(secondId, false);
      assert(terminalTabs.value.some((tab) => tab.id === secondId));

      closeTerminalTab(secondId);
      assertEquals(terminated, true);
      assertEquals(terminalTabs.value.map((tab) => tab.id), [firstId]);
    } finally {
      unregister();
    }
  });
});

Deno.test('an exited sole terminal is replaced with a fresh id', () => {
  preserveSignals(() => {
    const oldId = terminalTabs.value[0].id;
    terminalTabs.value = [{ id: oldId, title: 'Session 1', connected: true, pwd: '/tmp' }];
    activeTerminalTab.value = oldId;

    terminalTabExited(oldId);

    assertEquals(terminalTabs.value.length, 1);
    assertNotEquals(terminalTabs.value[0].id, oldId);
    assertEquals(terminalTabs.value[0].connected, false);
    assertEquals(terminalTabs.value[0].pwd, undefined);
    assertEquals(activeTerminalTab.value, terminalTabs.value[0].id);
  });
});

Deno.test('a copied browser workspace is reset without terminating its original shells', () => {
  preserveSignals(() => {
    const firstId = terminalTabs.value[0].id;
    const copiedWorkspaceId = terminalWorkspaceId.value;
    const secondId = openTerminalTab();
    let terminated = false;
    const unregister = registerTerminalTerminator(secondId, () => terminated = true);
    try {
      terminalOpen.value = true;
      resetCopiedTerminalWorkspace(copiedWorkspaceId);

      assertEquals(terminalTabs.value.length, 1);
      assertNotEquals(terminalTabs.value[0].id, firstId);
      assertNotEquals(terminalTabs.value[0].id, secondId);
      assertEquals(activeTerminalTab.value, terminalTabs.value[0].id);
      assertNotEquals(terminalWorkspaceId.value, copiedWorkspaceId);
      assertEquals(terminalOpen.value, false);
      assertEquals(terminated, false);
    } finally {
      unregister();
    }
  });
});
