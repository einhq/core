import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModuleInstallJob, ModuleInstallStatus } from '@ein/api';
import { formatCount } from '../../../lib/format.ts';
import { notifyBusy, type ProgressToast } from '../../../signals/notify.ts';
import { execCommand } from '../../../signals/shell-client.ts';
import { namesList } from './UpdateDialog.tsx';

/** How often `mod status` is asked while an install runs, and while none does. */
const RUNNING_POLL_MS = 2_000;
const IDLE_POLL_MS = 10_000;

/**
 * The module install EiN is running, whoever started it and from wherever (`mod status`), asked
 * every 2s while one runs and every 10s otherwise, and not while the tab is hidden. `seen` is
 * whether this page saw it running, so an install finished long before is not announced;
 * `onFinished` is called when one it saw running ends. `refresh` asks at once, after starting one.
 */
export function useModuleInstall(onFinished: () => void) {
  const [install, setInstall] = useState<ModuleInstallJob | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  const running = useRef<string | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const [tick, setTick] = useState(0);

  const ask = useCallback(async () => {
    try {
      const { install } = await execCommand<ModuleInstallStatus>('mod status');
      setInstall(install);
      if (install?.state === 'running') {
        running.current = install.id;
        setSeen(install.id);
      } else if (running.current !== null) {
        running.current = null;
        finished.current();
      }
    } catch {
      // Asked again on the next tick.
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const loop = async () => {
      if (!document.hidden) await ask();
      if (!stopped) timer = setTimeout(loop, running.current ? RUNNING_POLL_MS : IDLE_POLL_MS);
    };
    void loop();
    const onVisible = () => {
      if (document.hidden) return;
      clearTimeout(timer);
      void loop();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ask, tick]);

  return { install, seen: install !== null && install.id === seen, refresh: () => setTick((n) => n + 1) };
}

/** What `mod install` was asked, as the modules' names: a repository's address by the module it holds, a flag left out. */
const askedFor = (args: string[]): string[] => args.filter((arg) => !arg.startsWith('-')).map((arg) => /\/module-([^/@]+?)(?:\.git)?(?:@.*)?$/.exec(arg)?.[1] ?? arg);

/**
 * The install this page saw running, as a toast at the foot of the screen while the page is open:
 * what it installs, with a spinner, and how many files of the module it unpacks are in place; once
 * it ends, what it put in place, with Open for the first, or why it failed, with Details, which
 * `onDetails` shows, for the administrator. Leaving the page takes a running one's toast away; the
 * install goes on.
 */
export function useInstallToast(install: ModuleInstallJob | null, seen: boolean, onOpenModule: (name: string) => void, onDetails?: () => void) {
  const toast = useRef<{ id: string; handle: ProgressToast } | null>(null);
  const actions = useRef({ onOpenModule, onDetails });
  actions.current = { onOpenModule, onDetails };

  useEffect(() => {
    if (!install || !seen) return;
    const names = askedFor(install.args);
    if (install.state === 'running') {
      const unpacking = install.unpacking && ` · ${formatCount(install.unpacking.files)} files of ${install.unpacking.module} unpacked`;
      const message = `${names.length ? `Installing ${namesList(names)}` : 'Installing modules'}${unpacking ?? ''}`;
      if (toast.current?.id === install.id) toast.current.handle.update({ message });
      else {
        toast.current?.handle.dismiss();
        toast.current = { id: install.id, handle: notifyBusy({ message }) };
      }
      return;
    }
    if (toast.current?.id !== install.id) return;
    const handle = toast.current.handle;
    toast.current = null;
    const installed = install.installed ?? [];
    if (install.state === 'done') {
      const first = installed[0];
      handle.finish({
        color: 'green',
        message: installed.length === 0
          ? 'Nothing new: installed at that commit already'
          : namesList(installed.map((module) => `${module.updated ? 'updated' : 'installed'} ${[module.name, module.version].filter(Boolean).join(' ')}`)).replace(/^./, (c) =>
            c.toUpperCase()),
        action: first ? { label: `Open ${first.name}`, onClick: () => actions.current.onOpenModule(first.name) } : undefined,
      });
      return;
    }
    const why = install.result?.failed[0] ?? install.lines.findLast((line) => line.error)?.text;
    handle.finish({
      color: 'red',
      message: `The install failed${why ? `: ${why}` : ''}`,
      action: actions.current.onDetails ? { label: 'Details', onClick: () => actions.current.onDetails!() } : undefined,
    });
  }, [install, seen]);

  useEffect(() => () => {
    if (toast.current) toast.current.handle.dismiss();
  }, []);
}
