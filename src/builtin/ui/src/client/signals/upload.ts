import { computed, type ReadonlySignal, signal } from '@preact/signals-react';
import { fileUrl } from '../lib/file-url.ts';
import { shq } from '../lib/shquote.ts';
import {
  createUploadQueue,
  NO_UPLOADS,
  type UploadCounts,
  type UploadFailure,
  type UploadInFlight,
  type UploadOptions,
  type UploadTarget,
  type UploadTargetSummary,
} from '../lib/upload-queue.ts';
import { execCommand } from './shell-client.ts';

/** The counts are shown at most this often, however fast the files go. */
const PUBLISH_MS = 250;

/** The longest server answer a failure repeats. */
const ERROR_CHARS = 200;

const summary = signal<UploadCounts>(NO_UPLOADS);
const summaryByTarget = signal<Readonly<Record<string, UploadTargetSummary>>>({});
const inFlight = signal<readonly UploadInFlight[]>([]);
const failures = signal<readonly UploadFailure[]>([]);
const batchDone = signal<{ dirs: string[]; at: number } | null>(null);

/** Every file queued since the last `clearFinished`, counted by where it stands. */
export const uploadSummary: ReadonlySignal<UploadCounts> = summary;

/**
 * The same counts by target directory, as `addToQueue` was given it (or a target function
 * answered it), with what to call it. A staging category's uploads are the targets under its
 * directory (`uploadsUnder`).
 */
export const uploadSummaryByTarget: ReadonlySignal<Readonly<Record<string, UploadTargetSummary>>> = summaryByTarget;

/** The files being sent, at most four. */
export const uploadActive: ReadonlySignal<readonly UploadInFlight[]> = inFlight;

/** The last 200 files that did not make it, oldest first. */
export const uploadFailures: ReadonlySignal<readonly UploadFailure[]> = failures;

/** Files are queued or being sent. */
export const isUploading = computed(() => summary.value.queued + summary.value.active > 0);

/**
 * Set once the queue drains, naming every target directory that took a file — the directory
 * `addToQueue` was given, not the folders a kept folder tree made under it.
 *
 * A page showing one of them reloads itself from this. Per batch rather than per
 * file: dropping fifty pictures on an album is one thing that happened to it,
 * not fifty, and reloading the grid under each arrival would make the drop
 * unusable. Uploads still land asynchronously — the media pipeline has to read
 * a file's date before the timeline can place it — so a reload is a nudge, not
 * a guarantee that the pictures are already there.
 */
export const uploadBatchDone: ReadonlySignal<{ dirs: string[]; at: number } | null> = batchDone;

/** POST `file` into `dir`, which never replaces a file; answers the path it was stored at. */
const send = (file: File, dir: string, progress: (sent: number) => void, abort: AbortSignal): Promise<string> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    abort.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.upload.onprogress = (event) => progress(event.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(storedPathOf(xhr) ?? `${dir}/${file.name}`);
      else reject(new Error(xhr.responseText.trim().slice(0, ERROR_CHARS) || `upload refused (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.onabort = () => reject(new DOMException('upload cancelled', 'AbortError'));
    xhr.open('POST', `${fileUrl(dir)}/?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.send(file);
  });

/** The `path` of a `POST /file` answer, or undefined when the body is not one. */
function storedPathOf(xhr: XMLHttpRequest): string | undefined {
  try {
    const answer = JSON.parse(xhr.responseText) as { path?: unknown };
    return typeof answer.path === 'string' ? answer.path : undefined;
  } catch {
    return undefined;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let shownAt = 0;

const publish = () => {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  shownAt = Date.now();
  summary.value = queue.summary();
  summaryByTarget.value = queue.byTarget();
  inFlight.value = queue.active();
  failures.value = queue.failures();
};

const queue = createUploadQueue<File>({
  send,
  mkdir: (dirs) => execCommand(`mkdir -p ${dirs.map(shq).join(' ')}`).then(() => {}),
  changed: () => {
    if (timer === undefined) timer = setTimeout(publish, Math.max(0, shownAt + PUBLISH_MS - Date.now()));
  },
  drained: (roots) => {
    publish();
    if (roots.length > 0) batchDone.value = { dirs: roots, at: Date.now() };
  },
});

/**
 * Queue `files` into `target`, which the queue makes (`mkdir -p`) with the folders it needs under
 * it before the first file goes in. A name already taken in a directory is never replaced: the
 * file is stored under a numbered name beside it.
 */
export function addToQueue(files: File[], target: UploadTarget, options?: UploadOptions): void {
  queue.add(files, target, options);
}

/** Stop uploading: the files being sent are aborted and the queued ones dropped. */
export const cancelUploads = (): void => queue.cancel();

/** Queue every failed file again. */
export const retryFailed = (): void => queue.retry();

/** Forget the files that are done or failed. */
export const clearFinished = (): void => queue.clear();
