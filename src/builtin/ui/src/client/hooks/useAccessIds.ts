import { useEffect, useState } from 'react';
import type { AccessIds } from '../lib/access.ts';
import { execCommand } from '../signals/shell-client.ts';
import type { Whoami as WhoamiResult } from '@ein/api';
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
    return { uid: who.uid, gids: who.gids, admin: who.admin === true };
  } catch {
    return null;
  }
}

/** The reader's uid and group ids, fetched once per page load; null when they cannot be read. */
export const loadAccessIds = (): Promise<AccessIds | null> =>
  pending ??= fetchAccessIds().then((result) => {
    cached = result;
    return result;
  });

/** The reader's uid and group ids — the guest's too, whom `canAccess` never lets write; null while loading. */
export function useAccessIds(): AccessIds | null {
  const [ids, setIds] = useState<AccessIds | null>(cached);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    loadAccessIds().then((result) => {
      if (!cancelled) setIds(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return ids;
}
