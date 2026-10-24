import { assertEquals } from '@std/assert';
import { createCommandQueue } from '../command-queue.ts';

/** A task the test settles by hand, recording that it ran. */
const manual = (log: string[], name: string) => {
  let settle: { resolve: (value: string) => void; reject: (error: Error) => void } | undefined;
  const run = () => {
    log.push(`run ${name}`);
    return new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
  };
  return { run, resolve: () => settle!.resolve(name), reject: (message: string) => settle!.reject(new Error(message)) };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test('tasks run one at a time, in the order given', async () => {
  const queue = createCommandQueue();
  const log: string[] = [];
  const a = manual(log, 'a');
  const b = manual(log, 'b');
  queue.enqueue({ label: 'A', run: a.run, onDone: (value) => log.push(`done ${value}`) });
  queue.enqueue({ label: 'B', run: b.run, onDone: (value) => log.push(`done ${value}`) });
  await tick();
  assertEquals(log, ['run a']);
  assertEquals(queue.items().map((item) => [item.label, item.state]), [['A', 'running'], ['B', 'queued']]);
  assertEquals(queue.backlog(), 2);
  a.resolve();
  await tick();
  assertEquals(log, ['run a', 'done a', 'run b']);
  b.resolve();
  await queue.idle();
  assertEquals(log, ['run a', 'done a', 'run b', 'done b']);
  assertEquals([queue.items(), queue.backlog()], [[], 0]);
});

Deno.test('a task cancelled before it runs never runs', async () => {
  const queue = createCommandQueue();
  const log: string[] = [];
  const a = manual(log, 'a');
  const b = manual(log, 'b');
  queue.enqueue({ label: 'A', run: a.run });
  const second = queue.enqueue({ label: 'B', run: b.run, onCancel: () => log.push('cancelled b') });
  assertEquals(queue.cancel(second), true);
  a.resolve();
  await queue.idle();
  assertEquals(log, ['run a', 'cancelled b']);
  // One that has run cannot be.
  assertEquals(queue.cancel(second), false);
});

Deno.test('a failure is kept, rolled back by its callback, and runs again on retry at the end', async () => {
  const queue = createCommandQueue();
  const log: string[] = [];
  let attempt = 0;
  const failing = queue.enqueue({
    label: 'A',
    run: () => ++attempt === 1 ? Promise.reject(new Error('no access')) : Promise.resolve('a'),
    onDone: () => log.push('done a'),
    onFail: (error) => log.push(`rolled back a: ${error.message}`),
  });
  const b = manual(log, 'b');
  queue.enqueue({ label: 'B', run: b.run });
  await tick();
  assertEquals(log, ['rolled back a: no access', 'run b']);
  assertEquals(queue.items().map((item) => [item.label, item.state, item.error?.message]), [['A', 'failed', 'no access'], ['B', 'running', undefined]]);
  // The failure is not waiting: the backlog counts only what has yet to settle.
  assertEquals(queue.backlog(), 1);
  assertEquals(queue.retry(failing), true);
  b.resolve();
  await queue.idle();
  assertEquals(log, ['rolled back a: no access', 'run b', 'done a']);
});

Deno.test('a dismissed failure is forgotten, and subscribers hear every change', async () => {
  const queue = createCommandQueue();
  let heard = 0;
  const unsubscribe = queue.subscribe(() => heard++);
  const id = queue.enqueue({ label: 'A', run: () => Promise.reject(new Error('gone')) });
  await queue.idle();
  assertEquals(queue.items().length, 1);
  queue.dismiss(id);
  assertEquals(queue.items(), []);
  unsubscribe();
  const before = heard;
  queue.enqueue({ label: 'B', run: () => Promise.resolve() });
  await queue.idle();
  assertEquals(heard, before);
});
