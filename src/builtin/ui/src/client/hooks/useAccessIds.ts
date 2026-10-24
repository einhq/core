import { useEffect, useState } from 'react';
import type { AccessIds } from '../lib/access.ts';
import { execCommand } from '../signals/shell-client.ts';
import { shq } from '../lib/shquote.ts';
import type { GroupEntry, Whoami as WhoamiResult } from '@ein/api';
export type { GroupEntry, Whoami as WhoamiResult } from '@ein/api';

// One fetch per page load; access ids only change on login/logout, which
// load the page again.
let cached: AccessIds | null = null;
let pending: Promise<AccessIds | null> | null = null;

async function fetchAccessIds(): Promise<AccessIds | null> {
  try {
    const who = await execCommand<WhoamiResult>('user-whoami');
    if (!who || typeof who.uid !== 'number') {
      return null;
    }
    const groups = await execCommand<GroupEntry[]>(`user-groups ${shq(who.username)}`);
    return { uid: who.uid, gids: (groups ?? []).map((g) => g.gid), admin: who.admin === true };
  } catch {
    return null;
  }
}

/** The reader's uid and group ids — the guest's too, whom `canAccess` never lets write; null while loading. */
export function useAccessIds(): AccessIds | null {
  const [ids, setIds] = useState<AccessIds | null>(cached);

  useEffect(() => {
    if (cached) return;
    pending ??= fetchAccessIds().then((result) => {
      cached = result;
      return result;
    });
    let cancelled = false;
    pending.then((result) => {
      if (!cancelled) setIds(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return ids;
}
