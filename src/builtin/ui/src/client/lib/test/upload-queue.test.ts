import { assertEquals, assertThrows } from '@std/assert';
import { createUploadQueue, folderOf, leafDirs, NO_UPLOADS, type UploadFile, uploadsUnder } from '../upload-queue.ts';

/** A file as a drop or a picker gives it. */
const file = (name: string, size = 10, relativePath?: string): UploadFile => ({ name, size, ...(relativePath !== undefined ? { relativePath } : {}) });

/** A send the test settles by hand. */
type Pending = { file: UploadFile; dir: string; progress: (sent: number) => void; resolve: (path?: string) => void; reject: (error: Error) => void; aborted: () => boolean };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A queue whose sends and `mkdir`s wait for the test, recording what was asked of them. */
const harness = (options: { mkdirFails?: (dirs: string[]) => boolean } = {}) => {
  const sends: Pending[] = [];
  const mkdirs: string[][] = [];
  const drains: string[][] = [];
  /** Once set, a send settles as soon as it starts. */
  let instant = false;
  const queue = createUploadQueue<UploadFile>({
    send: (file, dir, progress, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
        sends.push({ file, dir, progress, resolve: (path) => resolve(path ?? `${dir}/${file.name}`), reject, aborted: () => signal.aborted });
        if (instant) sends.at(-1)!.resolve();
      }),
    mkdir: (dirs) => {
      mkdirs.push(dirs);
      return options.mkdirFails?.(dirs) ? Promise.reject(new Error('mkdir: permission denied')) : Promise.resolve();
    },
    changed: () => {},
    drained: (roots) => drains.push(roots),
  });
  /** Settle every send started so far, letting the next ones start; repeat until none are left. */
  const finishAll = async () => {
    let done = 0;
    for (await tick(); done < sends.length; await tick()) while (done < sends.length) sends[done++].resolve();
  };
  const settleAll = async () => {
    instant = true;
    for (const send of sends) send.resolve();
    await tick();
  };
  return { queue, sends, mkdirs, drains, finishAll, settleAll };
};

Deno.test('a file keeps the folders it was dropped or picked in, below the target', () => {
  assertEquals(folderOf(file('a.jpg', 1, '/Trip/day 1/a.jpg')), 'Trip/day 1');
  assertEquals(folderOf(file('a.jpg', 1, 'Trip/day 1/a.jpg')), 'Trip/day 1');
  assertEquals(folderOf(file('a.jpg', 1, './a.jpg')), '');
  assertEquals(folderOf(file('a.jpg')), '');
  assertEquals(folderOf({ name: 'a.jpg', size: 1, webkitRelativePath: 'Trip/a.jpg' }), 'Trip');
  assertEquals(folderOf(file('a.jpg', 1, 'Trip//./a.jpg')), 'Trip');
  assertThrows(() => folderOf(file('a.jpg', 1, 'Trip/../../a.jpg')), Error, 'refused folder');
});

Deno.test('mkdir is asked only for the directories no other one lies under', () => {
  assertEquals(leafDirs(['/t', '/t/a', '/t/a/b', '/t/c', '/t a']).sort(), ['/t a', '/t/a/b', '/t/c']);
  assertEquals(leafDirs(['/t', '/t']), ['/t']);
});

Deno.test('a dropped folder tree lands under the target, its directories made before its files', async () => {
  const { queue, sends, mkdirs, drains, finishAll } = harness();
  queue.add([file('a.jpg', 10, '/Trip/a.jpg'), file('b.jpg', 10, '/Trip/day 2/b.jpg'), file('c.jpg', 10, './c.jpg')], '/home/anna/up/', { keepFolders: true });
  await tick();
  assertEquals(mkdirs, [['/home/anna/up/Trip/day 2']]);
  assertEquals(sends.map((send) => send.dir), ['/home/anna/up/Trip', '/home/anna/up/Trip/day 2', '/home/anna/up']);
  await finishAll();
  assertEquals(drains, [['/home/anna/up']]);
});

Deno.test('without keepFolders every file goes straight into the target, which is still made', async () => {
  const { queue, sends, mkdirs } = harness();
  queue.add([file('a.jpg', 10, '/Trip/a.jpg'), file('b.jpg', 10, '/Trip/x/b.jpg')], '/albums/a/files');
  await tick();
  assertEquals(mkdirs, [['/albums/a/files']]);
  assertEquals(sends.map((send) => send.dir), ['/albums/a/files', '/albums/a/files']);
});

Deno.test('directories are made a hundred to one mkdir, in the order their files come', async () => {
  const { queue, mkdirs, finishAll } = harness();
  const files = Array.from({ length: 250 }, (_, i) => file(`f${i}.jpg`, 1, `/Box/${String(i).padStart(3, '0')}/f${i}.jpg`));
  queue.add(files, '/up', { keepFolders: true });
  await finishAll();
  assertEquals(mkdirs.map((dirs) => dirs.length), [100, 100, 50]);
  assertEquals(mkdirs[0][0], '/up/Box/000');
  assertEquals(mkdirs[2].at(-1), '/up/Box/249');
});

Deno.test('a folder above one that was made is not made again', async () => {
  const { queue, mkdirs, finishAll } = harness();
  queue.add([file('a.jpg', 1, '/T/x/y/a.jpg'), file('b.jpg', 1, '/T/x/b.jpg'), file('c.jpg', 1, '/T/c.jpg')], '/up', { keepFolders: true });
  await finishAll();
  assertEquals(mkdirs, [['/up/T/x/y']]);
});

Deno.test('four files are sent at once, and the next starts as one ends', async () => {
  const { queue, sends } = harness();
  queue.add(Array.from({ length: 10 }, (_, i) => file(`f${i}.jpg`)), '/up');
  await tick();
  assertEquals(sends.length, 4);
  assertEquals(queue.active().length, 4);
  assertEquals(queue.summary().queued, 6);
  sends[1].resolve();
  await tick();
  assertEquals(sends.length, 5);
  assertEquals(queue.active().map((item) => item.name), ['f0.jpg', 'f2.jpg', 'f3.jpg', 'f4.jpg']);
});

Deno.test('the counters follow every file and byte as it goes', async () => {
  const { queue, sends, drains } = harness();
  queue.add([file('a.jpg', 100), file('b.jpg', 50), file('c.jpg', 30)], '/up');
  await tick();
  assertEquals(queue.summary(), { ...NO_UPLOADS, active: 3, bytesTotal: 180 });
  sends[0].progress(40);
  sends[0].progress(70);
  assertEquals(queue.summary().bytesDone, 70);
  sends[0].resolve();
  sends[1].resolve('/up/b (2).jpg');
  sends[2].progress(10);
  sends[2].reject(new Error('disk full'));
  await tick();
  assertEquals(queue.summary(), { ...NO_UPLOADS, done: 2, renamed: 1, failed: 1, bytesTotal: 150, bytesDone: 150 });
  assertEquals(queue.failures(), [{ name: 'c.jpg', dir: '/up', error: 'disk full' }]);
  assertEquals(drains, [['/up']]);

  queue.retry();
  await tick();
  assertEquals(queue.summary(), { ...NO_UPLOADS, active: 1, done: 2, renamed: 1, bytesTotal: 180, bytesDone: 150 });
  assertEquals(queue.failures(), []);
  sends[3].resolve();
  await tick();
  assertEquals(queue.summary(), { ...NO_UPLOADS, done: 3, renamed: 1, bytesTotal: 180, bytesDone: 180 });

  queue.clear();
  assertEquals(queue.summary(), NO_UPLOADS);
  assertEquals(queue.byTarget(), {});
});

Deno.test('5,000 files in 50 folders are counted as they go, and all land', async () => {
  const { queue, sends, settleAll } = harness();
  queue.add(Array.from({ length: 5_000 }, (_, i) => file(`f${i}.jpg`, 2, `/A/${i % 50}/f${i}.jpg`)), '/up', { keepFolders: true });
  await tick();
  for (const send of sends) send.progress(1);
  assertEquals(queue.summary(), { ...NO_UPLOADS, queued: 4_996, active: 4, bytesTotal: 10_000, bytesDone: 4 });
  await settleAll();
  assertEquals(queue.summary(), { ...NO_UPLOADS, done: 5_000, bytesTotal: 10_000, bytesDone: 10_000 });
});

Deno.test('each target has its own summary, and a category sums the targets under it', async () => {
  const { queue, sends } = harness();
  queue.add([file('a.jpg', 10), file('b.jpg', 10)], '/s/files/inbox/upload-2026-10-18', { label: 'Inbox' });
  queue.add([file('c.jpg', 20)], '/s/files/scans/upload-2026-10-18', { label: 'Box 3' });
  queue.add([file('d.jpg', 5)], async () => '/s/files/scans/upload-2026-10-17/');
  await tick();
  await tick();
  sends[0].resolve();
  await tick();
  const byTarget = queue.byTarget();
  assertEquals(byTarget['/s/files/inbox/upload-2026-10-18'], { ...NO_UPLOADS, label: 'Inbox', done: 1, active: 1, bytesTotal: 20, bytesDone: 10 });
  assertEquals(byTarget['/s/files/scans/upload-2026-10-18'], { ...NO_UPLOADS, label: 'Box 3', active: 1, bytesTotal: 20 });
  assertEquals(byTarget['/s/files/scans/upload-2026-10-17'].label, 'upload-2026-10-17');
  assertEquals(uploadsUnder(byTarget, '/s/files/scans'), { ...NO_UPLOADS, active: 2, bytesTotal: 25 });
  assertEquals(uploadsUnder(byTarget, '/s/files/scan'), undefined);
});

Deno.test('a target function is asked once for all the files queued with it', async () => {
  const { queue, sends, finishAll, drains } = harness();
  let asked = 0;
  queue.add([file('a.jpg'), file('b.jpg'), file('c.jpg')], () => {
    asked++;
    return Promise.resolve('/made');
  });
  await finishAll();
  assertEquals(asked, 1);
  assertEquals(sends.map((send) => send.dir), ['/made', '/made', '/made']);
  assertEquals(drains, [['/made']]);
});

Deno.test('a directory that cannot be made fails its files, and Retry makes it again', async () => {
  let refuse = true;
  const { queue, sends, mkdirs } = harness({ mkdirFails: () => refuse });
  queue.add([file('a.jpg', 1, '/T/a.jpg'), file('b.jpg', 1, '/T/b.jpg')], '/up', { keepFolders: true });
  await tick();
  await tick();
  assertEquals(sends.length, 0);
  assertEquals(queue.summary().failed, 2);
  assertEquals(queue.failures()[0], { name: 'a.jpg', dir: '/up/T', error: 'mkdir: permission denied' });
  refuse = false;
  queue.retry();
  await tick();
  assertEquals(mkdirs.length, 2);
  assertEquals(sends.length, 2);
});

Deno.test('a file whose folder would leave the target fails at once, and the rest go', async () => {
  const { queue, sends } = harness();
  queue.add([file('a.jpg', 1, '../a.jpg/x'), file('b.jpg', 1, '/T/b.jpg')], '/up', { keepFolders: true });
  await tick();
  assertEquals(queue.summary().failed, 1);
  assertEquals(sends.map((send) => send.dir), ['/up/T']);
});

Deno.test('Cancel aborts what is being sent and drops what waits', async () => {
  const { queue, sends, drains } = harness();
  queue.add(Array.from({ length: 6 }, (_, i) => file(`f${i}.jpg`, 10)), '/up');
  await tick();
  sends[0].resolve();
  await tick();
  sends[1].progress(5);
  queue.cancel();
  await tick();
  assertEquals(sends.slice(1).map((send) => send.aborted()), [true, true, true, true]);
  assertEquals(queue.summary(), { ...NO_UPLOADS, done: 1, bytesTotal: 10, bytesDone: 10 });
  assertEquals(queue.active(), []);
  assertEquals(drains, [['/up']]);
});

Deno.test('only the last failures are kept to be listed', async () => {
  const sends: Pending[] = [];
  const queue = createUploadQueue<UploadFile>({
    send: (file, dir, progress) => new Promise((resolve, reject) => sends.push({ file, dir, progress, resolve: () => resolve(dir), reject, aborted: () => false })),
    mkdir: () => Promise.resolve(),
    changed: () => {},
    drained: () => {},
  }, { failuresKept: 3 });
  queue.add(Array.from({ length: 5 }, (_, i) => file(`f${i}.jpg`)), '/up');
  for (let i = 0; i < 5; i++) {
    await tick();
    sends[i].reject(new Error(`no ${i}`));
  }
  await tick();
  assertEquals(queue.failures().map((failure) => failure.error), ['no 2', 'no 3', 'no 4']);
  assertEquals(queue.summary().failed, 5);
});
