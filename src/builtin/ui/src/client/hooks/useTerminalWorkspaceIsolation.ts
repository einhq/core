import { resetCopiedTerminalWorkspace } from '@ein/ui/signals';
import { useEffect, useState } from 'react';

const CHANNEL_NAME = 'ein-terminal-workspace-owners-v1';
const CLAIM_SETTLE_MS = 150;

type WorkspaceMessage = {
  type: 'probe' | 'owned';
  workspaceId: string;
  pageId: string;
  requesterId?: string;
};

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const pageId = randomId();

function isWorkspaceMessage(value: unknown): value is WorkspaceMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<WorkspaceMessage>;
  return (message.type === 'probe' || message.type === 'owned') &&
    typeof message.workspaceId === 'string' && typeof message.pageId === 'string' &&
    (message.requesterId === undefined || typeof message.requesterId === 'string');
}

/**
 * Prevent two live browser pages from attaching the copied terminal ids.
 *
 * sessionStorage survives reload, which is what makes resume possible, but a
 * new tab with an opener may begin with a copy of it. BroadcastChannel lets a
 * page claim that copied workspace before any terminal WebSockets are opened.
 */
export function useTerminalWorkspaceIsolation(workspaceId: string): boolean {
  const [ownedWorkspaceId, setOwnedWorkspaceId] = useState<string>();

  useEffect(() => {
    setOwnedWorkspaceId(undefined);
    if (!workspaceId) return;

    if (typeof BroadcastChannel === 'undefined') {
      setOwnedWorkspaceId(workspaceId);
      return;
    }

    const channel = new BroadcastChannel(CHANNEL_NAME);
    let state: 'candidate' | 'owner' | 'lost' = 'candidate';

    const loseClaim = () => {
      if (state === 'lost') return;
      state = 'lost';
      clearTimeout(timer);
      channel.close();
      resetCopiedTerminalWorkspace(workspaceId);
    };

    channel.onmessage = (event) => {
      if (!isWorkspaceMessage(event.data)) return;
      const message = event.data;
      if (message.workspaceId !== workspaceId || message.pageId === pageId) return;

      if (message.type === 'probe') {
        if (state === 'owner') {
          channel.postMessage({ type: 'owned', workspaceId, pageId, requesterId: message.pageId } satisfies WorkspaceMessage);
        } else if (state === 'candidate' && message.pageId < pageId) {
          // If two copied pages start together, exactly one wins without both
          // deciding that the other is the established owner.
          loseClaim();
        }
        return;
      }

      if (state !== 'lost' && message.requesterId === pageId) loseClaim();
    };

    channel.postMessage({ type: 'probe', workspaceId, pageId } satisfies WorkspaceMessage);
    const timer = globalThis.setTimeout(() => {
      if (state !== 'candidate') return;
      state = 'owner';
      setOwnedWorkspaceId(workspaceId);
    }, CLAIM_SETTLE_MS);

    return () => {
      state = 'lost';
      clearTimeout(timer);
      channel.close();
    };
  }, [workspaceId]);

  return ownedWorkspaceId === workspaceId;
}
