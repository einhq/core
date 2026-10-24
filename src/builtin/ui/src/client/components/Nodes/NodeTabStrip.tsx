import { ActionIcon, CloseButton, Tooltip } from '@mantine/core';
import { IconPlus, IconX } from '@tabler/icons-react';
import type { NodeTab } from '../../lib/nodes-workspace.ts';
import { baseName } from '../../lib/node-path.ts';

type NodeTabStripProps = {
  tabs: NodeTab[];
  activeTabId: string;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
  /** Closes the whole pane, when there is another to take its location. */
  onClosePane?: () => void;
};

/** A tab is named by the last segment of its path; the root has none, so it is `/`. */
const tabTitle = (tab: NodeTab): string => baseName(tab.path) || '/';

/**
 * The tabs of one pane, standing on the page bar's bottom edge over their
 * pane (`.mrx-nodes-tabs` in theme.css). Middle-click closes, as in a
 * browser; the last tab has no close button since the pane cannot be empty.
 * With two panes, the strip's far end closes this one; it stays put while
 * the tabs scroll.
 */
export function NodeTabStrip({ tabs, activeTabId, onActivate, onClose, onAdd, onClosePane }: NodeTabStripProps) {
  return (
    <div className='mrx-nodes-tabs'>
      <div className='mrx-nodes-tabs-scroll' role='tablist'>
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className='mrx-nodes-tab'
              role='tab'
              aria-selected={active}
              data-active={active || undefined}
              onClick={() => onActivate(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1 && tabs.length > 1) onClose(tab.id);
              }}
              title={tab.path}
            >
              <span className='mrx-nodes-tab-label'>{tabTitle(tab)}</span>
              {tabs.length > 1 && (
                <CloseButton
                  size='xs'
                  aria-label='Close tab'
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(tab.id);
                  }}
                />
              )}
            </div>
          );
        })}
        <Tooltip label='New tab' withArrow>
          <ActionIcon variant='subtle' size='lg' className='mrx-nodes-new-tab' onClick={onAdd} aria-label='New tab'>
            <IconPlus size={22} stroke={2.75} />
          </ActionIcon>
        </Tooltip>
      </div>
      {onClosePane && (
        <Tooltip label='Close pane' withArrow>
          <ActionIcon variant='subtle' size='sm' onClick={onClosePane} aria-label='Close pane'>
            <IconX size={14} />
          </ActionIcon>
        </Tooltip>
      )}
    </div>
  );
}
