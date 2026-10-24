import { useSignals } from '@preact/signals-react/runtime';
import { useTerminalWorkspaceIsolation } from '@ein/ui/hooks';
import { activeTerminalTab, terminalHeight, terminalOpen, terminalOpenToggle, terminalTabs, terminalWorkspaceId } from '@ein/ui/signals';
import { useEffect, useRef } from 'react';
import { handleTerminalShortcut } from './shortcuts.ts';
import { TerminalInstance } from './TerminalInstance.tsx';
import { TerminalTabs } from './TerminalTabs.tsx';

export function Terminal() {
  useSignals();
  const isOpen = terminalOpen.value;
  const height = terminalHeight.value;
  const tabs = terminalTabs.value;
  const activeTabId = activeTerminalTab.value;
  const workspaceOwned = useTerminalWorkspaceIsolation(terminalWorkspaceId.value);
  const paneRef = useRef<HTMLDivElement>(null);

  // Global keyboard shortcuts, for when the terminal is not focused. A focused
  // terminal handles them in TerminalInstance and stops them propagating here.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      handleTerminalShortcut(e);
    };

    globalThis.addEventListener('keydown', handleKeyDown);
    return () => globalThis.removeEventListener('keydown', handleKeyDown);
  }, []);

  // A press outside the open pane closes it. Controls that toggle the terminal
  // themselves carry data-terminal-toggle, so their own click is not undone.
  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || paneRef.current?.contains(target) || target.closest('[data-terminal-toggle]')) return;
      terminalOpenToggle();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [isOpen]);

  return (
    <div ref={paneRef} className={`terminal-pane ${isOpen ? 'open' : ''}`} style={{ height: `${height}vh` }}>
      <div className='terminal-content'>
        {workspaceOwned && tabs.map((tab) => (
          <div
            key={tab.id}
            className='terminal-tab-content'
            style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
          >
            <TerminalInstance
              tabId={tab.id}
              isActive={tab.id === activeTabId}
              initialCommand={tab.initialCommand}
            />
          </div>
        ))}
      </div>
      <TerminalTabs />
    </div>
  );
}
