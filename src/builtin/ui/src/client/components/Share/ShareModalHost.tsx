import { useSignals } from '@preact/signals-react/runtime';
import { closeShareModal, shareModalPath } from '@ein/ui/signals';
import { useEffect, useState } from 'react';
import { ShareModal } from './ShareModal.tsx';

/** The node the dialog is drawing, and which opening of it this is. */
type Session = { path: string; opening: number };

/**
 * The one sharing dialog, mounted at the app root.
 *
 * `ShareButton` only asks for it, because the button is normally a `Menu.Item`
 * and a dialog rendered inside a menu dropdown is unmounted the moment the menu
 * closes.
 *
 * The session outlives the request that opened it so the dialog can fade out
 * rather than vanish, and its opening number keys the dialog: every opening
 * gets a fresh one, so a draft abandoned with Cancel is never what the next
 * opening shows while it reads the node again.
 */
export function ShareModalHost() {
  useSignals();
  const path = shareModalPath.value;
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (path !== null) setSession((current) => ({ path, opening: (current?.opening ?? 0) + 1 }));
  }, [path]);

  if (!session) return null;

  return <ShareModal key={session.opening} path={session.path} opened={path !== null} onClose={closeShareModal} />;
}
