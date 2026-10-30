import { assertEquals } from '@std/assert';
import { addTerminalTab, closeTerminalTab, terminalTabs } from './terminal.ts';

Deno.test('a new tab takes the lowest session number no open tab has', () => {
  const second = addTerminalTab();
  addTerminalTab();
  assertEquals(terminalTabs.value.map((tab) => tab.title), ['Session 1', 'Session 2', 'Session 3']);

  closeTerminalTab(second);
  addTerminalTab();
  addTerminalTab();
  assertEquals(terminalTabs.value.map((tab) => tab.title), ['Session 1', 'Session 3', 'Session 2', 'Session 4']);
});
