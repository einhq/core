import { useSignals } from '@preact/signals-react/runtime';
import { closeDialog, dialogPath } from '@ein/ui/signals';
import { usePhone } from '../../hooks/usePhone.ts';
import { useBackCloses } from './Dialog.tsx';
import { SurfaceRouter } from './SurfaceRouter.tsx';

/**
 * The shell's dialog, mounted once: the route `openDialog` was given, over the page. On a phone
 * Back closes it (`useBackCloses`), here rather than in its frame, which is drawn once while the
 * route loads and again when it has.
 */
export function DialogHost() {
  useSignals();
  const path = dialogPath.value;
  useBackCloses(usePhone() && path !== null, closeDialog);
  if (!path) return null;
  return <SurfaceRouter key={path} kind='dialog' path={path} onClose={closeDialog} />;
}
