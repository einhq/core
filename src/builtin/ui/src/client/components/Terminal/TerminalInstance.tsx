import { Dropzone } from '@mantine/dropzone';
import { useResizeObserver } from '@mantine/hooks';
import { useSignals } from '@preact/signals-react/runtime';
import { useWebSocket, useXtermMedia } from '@ein/ui/hooks';
import {
  addToQueue,
  registerTerminalTerminator,
  resetCopiedTerminalWorkspace,
  setTabConnected,
  setTabPwd,
  terminalOpen,
  terminalTabExited,
  terminalTabs,
  terminalWorkspaceId,
} from '@ein/ui/signals';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as Term } from '@xterm/xterm';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { bindScrollbar } from '../Layout/scrollbar.ts';
import { handleTerminalShortcut } from './shortcuts.ts';

type Props = {
  tabId: string;
  isActive: boolean;
  initialCommand?: string;
};

const LINE_HEIGHT = 14;

export function TerminalInstance({ tabId, isActive, initialCommand }: Props) {
  useSignals();

  // Mantine 9's useResizeObserver hands back a callback ref, but xterm needs the
  // element itself (term.open, viewport lookup) and useXtermMedia wants a RefObject,
  // so keep our own ref and feed the observer alongside it.
  const [observerRef, rect] = useResizeObserver<HTMLDivElement>();
  const ref = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback((node: HTMLDivElement | null) => {
    ref.current = node;
    observerRef(node);
  }, [observerRef]);
  const fitAddon = useMemo(() => new FitAddon(), []);
  const ws = useWebSocket(`/__shell?mode=interactive&terminalId=${encodeURIComponent(tabId)}`);
  const initialCommandSentRef = useRef(false);

  const handleUpload = (files: File[]) => {
    if (files.length > 0) {
      const pwd = terminalTabs.value.find((t) => t.id === tabId)?.pwd || '/';
      addToQueue(files, pwd);
    }
  };

  const term = useMemo(() => {
    const t = new Term({
      allowTransparency: true,
      cursorBlink: true,
      convertEol: true,
      fontSize: LINE_HEIGHT,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#101217',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5',
      },
    });

    t.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (ev.type !== 'keydown') return true;

      if (handleTerminalShortcut(ev, tabId)) return false;

      if (ev.key === 'r' && ev.ctrlKey) {
        ev.preventDefault();
        return true;
      }

      if (ev.key === 'F5') {
        return false;
      }

      return true;
    });

    t.loadAddon(fitAddon);
    return t;
  }, [fitAddon, tabId]);

  const onConnectState = (connected: boolean) => {
    setTabConnected(tabId, connected);
  };

  useEffect(() => {
    ws.onPwd((path) => setTabPwd(tabId, path));
    ws.onData((data) => term.write(data));
    ws.onConnectState(onConnectState);
    ws.onRestore(async ({ snapshot, rows, cols, pwd }) => {
      setTabPwd(tabId, pwd);
      term.reset();
      term.resize(cols, rows);
      await new Promise<void>((resolve) => term.write(snapshot, resolve));
      if (ref.current?.offsetParent !== null) {
        fitAddon.fit();
        ws.sendResize(term.cols, term.rows);
      }
    });
    ws.onTerminalExit(() => terminalTabExited(tabId));
    ws.onTerminalConflict(() => resetCopiedTerminalWorkspace(terminalWorkspaceId.value));
    const unregisterTerminator = registerTerminalTerminator(tabId, () => ws.terminate());
    const dispose = term.onData((data) => ws.send(data));

    return () => {
      ws.onPwd(undefined);
      ws.onData(undefined);
      ws.onConnectState(undefined);
      ws.onRestore(undefined);
      ws.onTerminalExit(undefined);
      ws.onTerminalConflict(undefined);
      unregisterTerminator();
      dispose.dispose();
    };
  }, [ws, term]);

  // `send` queues while the socket is opening. The ref keeps a reconnect from
  // unexpectedly changing directory again after somebody has moved elsewhere.
  useEffect(() => {
    if (!initialCommand || initialCommandSentRef.current) return;
    initialCommandSentRef.current = true;
    ws.send(`${initialCommand}\r`);
  }, [initialCommand, ws]);

  // Open terminal once
  useEffect(() => {
    if (!term || !ref.current) return;
    if (ref.current.getAttribute('data-open')) return;

    term.open(ref.current);
    ref.current.setAttribute('data-open', '1');

    const viewport = ref.current.querySelector('.xterm-viewport') as HTMLElement;
    if (viewport) {
      viewport.style.backgroundColor = 'transparent';
    }

    requestAnimationFrame(() => {
      fitAddon.fit();
      ws.sendResize(term.cols, term.rows);
      term.focus();
    });
  }, [ref, term, fitAddon, ws]);

  // The app's scrollbar (`bindScrollbar`) over the scrollback, in place of the browser's, which
  // `theme.css` hides. It goes inside xterm's element, in the gutter xterm keeps for a scrollbar,
  // so a wheel over it reaches xterm as one over the text does.
  useEffect(() => {
    const element = term.element;
    const viewport = element?.querySelector<HTMLElement>('.xterm-viewport');
    const scrollArea = element?.querySelector<HTMLElement>('.xterm-scroll-area');
    if (!element || !viewport || !scrollArea) return;
    const track = document.createElement('div');
    track.className = 'mrx-scrollbar terminal-scrollbar';
    track.setAttribute('aria-hidden', 'true');
    const thumb = document.createElement('div');
    thumb.className = 'mrx-scrollbar-thumb';
    track.append(thumb);
    element.append(track);
    const unbind = bindScrollbar(track, thumb, {
      element: viewport,
      events: viewport,
      // The scroll's length is the scroll area's height, which xterm sets as the scrollback grows.
      watch: (changed) => {
        const observer = new ResizeObserver(changed);
        observer.observe(scrollArea);
        return () => observer.disconnect();
      },
    });
    return () => {
      unbind();
      track.remove();
    };
  }, [term]);

  // Resize observer
  useEffect(() => {
    if (!term || !rect.width || !rect.height) return;
    if (isActive) {
      fitAddon.fit();
      ws.sendResize(term.cols, term.rows);
      term.focus();
    }
  }, [ws, term, rect.width, rect.height, isActive, ws]);

  // Focus on tab activation
  useEffect(() => {
    if (isActive && term) {
      requestAnimationFrame(() => {
        fitAddon.fit();
        ws.sendResize(term.cols, term.rows);
        term.focus();
      });
    }
  }, [isActive, term, fitAddon]);

  // Focus when terminal pane opens
  useEffect(() => {
    if (terminalOpen.value && isActive && term) {
      requestAnimationFrame(() => {
        fitAddon.fit();
        ws.sendResize(term.cols, term.rows);
        term.focus();
      });
    }
  }, [terminalOpen.value, isActive, term, fitAddon, ws]);

  useXtermMedia(term, ref, {
    mediaBaseUrl: '/file',
  });

  return (
    <Dropzone
      onDrop={handleUpload}
      activateOnClick={false}
      activateOnKeyboard={false}
      dragEventsBubbling={false}
      enablePointerEvents
      style={{ height: '100%' }}
    >
      <div
        className='terminal-container'
        ref={setRef}
        style={{ height: '100%' }}
      />
    </Dropzone>
  );
}
