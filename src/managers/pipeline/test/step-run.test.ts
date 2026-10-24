/**
 * A pipeline step runs to its end, however long it takes; only its caller
 * hanging up stops it. What it writes is reported as it goes, as the sign that
 * tells a slow step from a stuck one.
 */

import { assert, assertEquals } from '@std/assert';
import type { RunAndCaptureOptions, RunAndCaptureResult, TtyIf } from '../../exec/mod.ts';
import type { NodeVFS } from '../../../vfs/node-vfs.ts';
import { markOutput, runStep, STEP_HUNG_UP_CODE } from '../step-run.ts';

const GRACE_MS = 200;

type Capture = (script: string, opts: RunAndCaptureOptions) => Promise<RunAndCaptureResult>;

/** `seen` holds the options each capture was given. */
function fakeTty(capture: Capture): { tty: TtyIf; seen: RunAndCaptureOptions[] } {
  const seen: RunAndCaptureOptions[] = [];
  const tty = {
    runAndCapture: (script: string, _ctx?: unknown, opts: RunAndCaptureOptions = {}) => {
      seen.push(opts);
      return capture(script, opts);
    },
  } as unknown as TtyIf;
  return { tty, seen };
}

/** A tool that swallows SIGTERM: the capture never settles. */
const ignoresSigterm: Capture = () => new Promise<RunAndCaptureResult>(() => {});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test('a step is given no deadline', async () => {
  const { tty, seen } = fakeTty(async () => {
    await sleep(50);
    return { code: 0, stdout: 'done', stderr: '' };
  });

  const result = await runStep(tty, 'step-command', { graceMs: GRACE_MS });

  assertEquals(result, { code: 0, stdout: 'done', stderr: '' });
  assertEquals(seen[0].timeoutMs, undefined);
});

Deno.test('a non-zero exit is passed through with what the step wrote', async () => {
  const { tty } = fakeTty(() => Promise.resolve({ code: 3, stdout: '', stderr: 'boom' }));

  assertEquals(await runStep(tty, 'step-command'), { code: 3, stdout: '', stderr: 'boom' });
});

Deno.test("the step's output reaches onOutput", async () => {
  let calls = 0;
  const { tty } = fakeTty((_script, opts) => {
    opts.onOutput?.();
    opts.onOutput?.();
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  });

  await runStep(tty, 'step-command', { onOutput: () => calls++ });

  assertEquals(calls, 2);
});

Deno.test('a hang-up is passed to the shell, which stops the step', async () => {
  const hangUp = new AbortController();
  const { tty } = fakeTty((_script, opts) =>
    new Promise((resolve) => {
      opts.signal?.addEventListener('abort', () => resolve({ code: 143, stdout: '', stderr: 'terminated' }), { once: true });
    })
  );

  const run = runStep(tty, 'step-command', { signal: hangUp.signal, graceMs: GRACE_MS });
  hangUp.abort();

  assertEquals((await run).code, 143);
});

Deno.test('a step that ignores a hang-up is abandoned after the grace', async () => {
  const hangUp = new AbortController();
  const { tty } = fakeTty(ignoresSigterm);

  const started = Date.now();
  const run = runStep(tty, 'step-command', { signal: hangUp.signal, graceMs: GRACE_MS });
  hangUp.abort();
  const result = await run;

  assertEquals(result.code, STEP_HUNG_UP_CODE);
  assert(result.stderr.includes('hung up'), result.stderr);
  assert(Date.now() - started >= GRACE_MS, `gave up after ${Date.now() - started}ms`);
});

Deno.test('markOutput writes the time of the latest output once per tick, and nothing when the step is silent', async () => {
  const writes: { path: string; outputAt: number }[] = [];
  const vfs = {
    update: (_access: unknown, path: string, change: { attrs: { outputAt: number } }) => {
      writes.push({ path, outputAt: change.attrs.outputAt });
      return Promise.resolve();
    },
  } as unknown as NodeVFS;

  const mark = markOutput(vfs, '/pipelines/instances/p/1/steps/s', 30);
  try {
    await sleep(70);
    assertEquals(writes, [], 'no output, no mark');

    const before = Date.now();
    mark.onOutput();
    mark.onOutput();
    await sleep(70);
    assertEquals(writes.length, 1, 'one mark for output since the last tick');
    assertEquals(writes[0].path, '/pipelines/instances/p/1/steps/s');
    assert(writes[0].outputAt >= before);
  } finally {
    mark.stop();
  }
});
