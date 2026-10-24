import {
  addTerminalTab,
  closeTerminalTab,
  decreaseTerminalHeight,
  increaseTerminalHeight,
  nextTerminalTab,
  prevTerminalTab,
  terminalMaximizedToggle,
  terminalOpenToggle,
} from '@ein/ui/signals';

/**
 * Run the Alt-based terminal shortcut for a keydown event, if any.
 *
 * Both the window listener in `Terminal` and xterm's key handler in
 * `TerminalInstance` dispatch through this. xterm listens on its own textarea,
 * so a keypress inside a focused terminal would otherwise bubble on and run the
 * action a second time — Alt+T would toggle the pane closed and straight back open.
 * Stopping propagation here keeps a handled shortcut to a single action.
 *
 * `tabId` enables the shortcuts that act on one tab; omit it outside a terminal.
 * Returns whether the event was handled.
 */
export function handleTerminalShortcut(e: KeyboardEvent, tabId?: string): boolean {
  if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return false;

  switch (e.key) {
    case 't':
      terminalOpenToggle();
      break;
    case 'n':
      addTerminalTab();
      break;
    case 'm':
      terminalMaximizedToggle();
      break;
    case 'ArrowRight':
      nextTerminalTab();
      break;
    case 'ArrowLeft':
      prevTerminalTab();
      break;
    case 'ArrowDown':
      increaseTerminalHeight();
      break;
    case 'ArrowUp':
      decreaseTerminalHeight();
      break;
    case 'w':
      if (tabId === undefined) return false;
      closeTerminalTab(tabId);
      break;
    default:
      return false;
  }

  e.preventDefault();
  e.stopPropagation();
  return true;
}
