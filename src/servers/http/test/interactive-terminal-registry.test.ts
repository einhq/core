import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { SerializeAddon } from '@xterm/addon-serialize';
import HeadlessXterm from '@xterm/headless';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { NODE_TYPE_TTY } from '../../../vfs/types/tty.ts';
import {
  type InteractiveTerminalPeer,
  InteractiveTerminalRegistry,
  TERMINAL_SCROLLBACK_LINES,
  terminalReconnectGraceMs,
  type TerminalRestoreMessage,
} from '../ws/interactive-terminal-registry.ts';

class ProbePeer implements InteractiveTerminalPeer {
  readyState: number = WebSocket.OPEN;
  messages: string[] = [];
  closeCode?: number;

  send(data: string): void {
    this.messages.push(data);
  }

  close(code?: number): void {
    this.closeCode = code;
    this.readyState = WebSocket.CLOSED;
  }

  restore(): TerminalRestoreMessage {
    const message = this.messages.map((data) => {
      try {
        return JSON.parse(data);
      } catch {
        return undefined;
      }
    }).find((value) => value?.type === 'restore');
    assert(message, `no restore message in ${JSON.stringify(this.messages)}`);
    return message;
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function ttyNames(vfs: Awaited<ReturnType<SystemTestHarness['startPrimary']>>['vfs'], sessionPath: string): Promise<string[]> {
  return (await vfs.children(ADMIN_ACCESS, sessionPath))
    .filter(({ node }) => node.type === NODE_TYPE_TTY)
    .map(({ name }) => name);
}

Deno.test({
  name: 'interactive terminal registry retains and restores browser shells',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const harness = new SystemTestHarness({ boot: true, ssh: false });
    const primary = await harness.startPrimary();
    const config = {
      vfs: primary.vfs,
      cem: primary.cem,
      bufferManager: primary.bufferManager,
      env: primary.shell.getEnv(),
    };

    try {
      await t.step('uses the configured five-minute default and rejects invalid values', () => {
        assertEquals(terminalReconnectGraceMs({}), 300_000);
        assertEquals(terminalReconnectGraceMs({ CFG_TERMINAL_RECONNECT_GRACE_SEC: '2.5' }), 2500);
        assertEquals(terminalReconnectGraceMs({ CFG_TERMINAL_RECONNECT_GRACE_SEC: '-1' }), 300_000);
        assertEquals(terminalReconnectGraceMs({ CFG_TERMINAL_RECONNECT_GRACE_SEC: 'never' }), 300_000);
      });

      await t.step('reconnects to the same cwd and replays output produced while detached', async () => {
        const { sessionPath } = await harness.createHttpSession();
        const registry = new InteractiveTerminalRegistry(config, 500);
        try {
          const firstPeer = new ProbePeer();
          const first = await registry.attach(sessionPath, 'tab-reload', firstPeer, { resumable: true });
          assertEquals(firstPeer.restore().resumed, false);

          await first.write('cd /tmp\r');
          await waitFor(
            () => firstPeer.messages.some((message) => message.includes('"type":"pwd"') && message.includes('/tmp')),
            'terminal did not change cwd',
          );
          const before = await ttyNames(primary.vfs, sessionPath);
          assertEquals(before.length, 1);

          await first.write('sleep 0.05 && echo survived-reload\r');
          await first.detach();
          await new Promise((resolve) => setTimeout(resolve, 100));

          const secondPeer = new ProbePeer();
          const second = await registry.attach(sessionPath, 'tab-reload', secondPeer, { resumable: true });
          const restore = secondPeer.restore();
          assertEquals(restore.resumed, true);
          assertEquals(restore.pwd, '/tmp');
          assert(restore.snapshot.includes('survived-reload'), restore.snapshot);
          assertEquals(await ttyNames(primary.vfs, sessionPath), before);

          await second.write('echo partial-');
          await second.detach();
          const thirdPeer = new ProbePeer();
          const third = await registry.attach(sessionPath, 'tab-reload', thirdPeer, { resumable: true });
          await third.write('input\r');
          await waitFor(() => thirdPeer.messages.some((message) => message.includes('partial-input')), 'partial input was not retained');
          assertEquals(await ttyNames(primary.vfs, sessionPath), before);
          await third.terminate();
        } finally {
          await registry.dispose();
        }
      });

      await t.step('a stale socket cannot detach its replacement', async () => {
        const { sessionPath } = await harness.createHttpSession();
        const registry = new InteractiveTerminalRegistry(config, 40);
        try {
          const firstPeer = new ProbePeer();
          const first = await registry.attach(sessionPath, 'tab-takeover', firstPeer, { resumable: true });
          const originalTty = (await ttyNames(primary.vfs, sessionPath))[0];

          const secondPeer = new ProbePeer();
          const second = await registry.attach(sessionPath, 'tab-takeover', secondPeer, { resumable: true });
          assertEquals(firstPeer.closeCode, 4001);
          await first.detach();
          await new Promise((resolve) => setTimeout(resolve, 80));
          assertEquals(await ttyNames(primary.vfs, sessionPath), [originalTty]);

          await second.write('echo replacement-alive\r');
          await waitFor(() => secondPeer.messages.some((message) => message.includes('replacement-alive')), 'replacement socket received no output');
          await second.terminate();
        } finally {
          await registry.dispose();
        }
      });

      await t.step('expiry closes the old tty and a later attach starts fresh', async () => {
        const { sessionPath } = await harness.createHttpSession();
        const registry = new InteractiveTerminalRegistry(config, 30);
        try {
          const first = await registry.attach(sessionPath, 'tab-expire', new ProbePeer(), { resumable: true });
          const oldTty = (await ttyNames(primary.vfs, sessionPath))[0];
          await first.detach();
          await waitFor(() => ttyNames(primary.vfs, sessionPath).then((names) => names.length === 0), 'expired tty was not removed');

          const nextPeer = new ProbePeer();
          const next = await registry.attach(sessionPath, 'tab-expire', nextPeer, { resumable: true });
          assertEquals(nextPeer.restore().resumed, false);
          const newTty = (await ttyNames(primary.vfs, sessionPath))[0];
          assertNotEquals(newTty, oldTty);
          await next.terminate();
        } finally {
          await registry.dispose();
        }
      });

      await t.step('a changed grace applies from the next disconnect', async () => {
        const { sessionPath } = await harness.createHttpSession();
        const registry = new InteractiveTerminalRegistry(config);
        const admin = await harness.createShellClient();
        try {
          const first = await registry.attach(sessionPath, 'tab-grace', new ProbePeer(), { resumable: true });
          await first.detach();
          await new Promise((resolve) => setTimeout(resolve, 50));
          const secondPeer = new ProbePeer();
          const second = await registry.attach(sessionPath, 'tab-grace', secondPeer, { resumable: true });
          assertEquals(secondPeer.restore().resumed, true);

          await admin.exec('config set CFG_TERMINAL_RECONNECT_GRACE_SEC 0');
          await second.detach();
          assertEquals(await ttyNames(primary.vfs, sessionPath), []);
        } finally {
          await admin.exec('config unset CFG_TERMINAL_RECONNECT_GRACE_SEC');
          admin.close();
          await registry.dispose();
        }
      });

      await t.step('the same terminal id is isolated by HTTP session', async () => {
        const firstSession = await harness.createHttpSession();
        const secondSession = await harness.createHttpSession();
        const registry = new InteractiveTerminalRegistry(config, 500);
        try {
          const first = await registry.attach(firstSession.sessionPath, 'shared-id', new ProbePeer(), { resumable: true });
          const second = await registry.attach(secondSession.sessionPath, 'shared-id', new ProbePeer(), { resumable: true });
          assertEquals((await ttyNames(primary.vfs, firstSession.sessionPath)).length, 1);
          assertEquals((await ttyNames(primary.vfs, secondSession.sessionPath)).length, 1);
          await first.terminate();
          assertEquals((await ttyNames(primary.vfs, secondSession.sessionPath)).length, 1);
          await second.terminate();
        } finally {
          await registry.dispose();
        }
      });

      await t.step("logging out ends the session's terminals and no other session's", async () => {
        const loggedOut = await harness.createHttpSession();
        const other = await harness.createHttpSession();
        const registry = new InteractiveTerminalRegistry(config, 500);
        const exited = (peer: ProbePeer) => peer.messages.some((message) => message.includes('"type":"terminal-exit"'));
        try {
          const typingPeer = new ProbePeer();
          const typing = await registry.attach(loggedOut.sessionPath, 'tab-typing', typingPeer, { resumable: true });
          const siblingPeer = new ProbePeer();
          const sibling = await registry.attach(loggedOut.sessionPath, 'tab-sibling', siblingPeer, { resumable: true });
          // A detached terminal is the one a reload would have reattached.
          await sibling.detach();
          const otherPeer = new ProbePeer();
          const otherTerminal = await registry.attach(other.sessionPath, 'tab-typing', otherPeer, { resumable: true });

          // Typed into one of the shells being ended, so closing must not wait on the command.
          await typing.write('logout --session\r');
          await waitFor(() => exited(typingPeer), 'the terminal that ran logout did not end');
          assertEquals(typingPeer.closeCode, 1000);
          await waitFor(
            () => ttyNames(primary.vfs, loggedOut.sessionPath).then((names) => names.length === 0),
            'a logged-out terminal kept its tty',
          );
          assert(!exited(otherPeer));
          assertEquals((await ttyNames(primary.vfs, other.sessionPath)).length, 1);

          const nextPeer = new ProbePeer();
          const next = await registry.attach(loggedOut.sessionPath, 'tab-sibling', nextPeer, { resumable: true });
          assertEquals(nextPeer.restore().resumed, false);
          await next.terminate();
          await otherTerminal.terminate();
        } finally {
          await registry.dispose();
        }
      });

      await t.step('legacy clients close immediately and registry shutdown disposes retained shells', async () => {
        const legacySession = await harness.createHttpSession();
        const retainedSession = await harness.createHttpSession();
        const registry = new InteractiveTerminalRegistry(config, 500);

        const legacy = await registry.attach(legacySession.sessionPath, 'legacy-probe', new ProbePeer(), { resumable: false });
        await legacy.detach();
        await waitFor(
          () => ttyNames(primary.vfs, legacySession.sessionPath).then((names) => names.length === 0),
          'legacy tty was retained',
        );

        await registry.attach(retainedSession.sessionPath, 'retained-probe', new ProbePeer(), { resumable: true });
        assertEquals((await ttyNames(primary.vfs, retainedSession.sessionPath)).length, 1);
        await registry.dispose();
        await waitFor(
          () => ttyNames(primary.vfs, retainedSession.sessionPath).then((names) => names.length === 0),
          'registry shutdown left a tty behind',
        );
      });
    } finally {
      await harness.stop();
    }
  },
});

Deno.test('headless terminal snapshot retains dimensions, ANSI state, alternate screen, and bounded scrollback', async () => {
  const terminal = new HeadlessXterm.Terminal({
    allowProposedApi: true,
    cols: 20,
    rows: 2,
    scrollback: TERMINAL_SCROLLBACK_LINES,
    convertEol: true,
  });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));

  try {
    await write(Array.from({ length: 1010 }, (_, index) => `line-${String(index + 1).padStart(4, '0')}\n`).join(''));
    const scrollback = serializer.serialize();
    assert(!scrollback.includes('line-0001'));
    assert(scrollback.includes('line-1010'));

    await write('\x1b[?1049h\x1b[31mALT-SCREEN');
    const alternate = serializer.serialize();
    assert(alternate.includes('\x1b[31m'));
    assert(alternate.includes('\x1b[?1049h'));
    assert(alternate.includes('ALT-SCREEN'));

    terminal.resize(120, 40);
    assertEquals([terminal.cols, terminal.rows], [120, 40]);
  } finally {
    serializer.dispose();
    terminal.dispose();
  }
});
