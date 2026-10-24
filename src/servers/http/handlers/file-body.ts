import type { ResourceHandleIf } from '../../../registries/types.ts';

/** The HTTP response owns its handle, including EOF, ranges and disconnects. */
export function fileBody(handle: ResourceHandleIf, length: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  let remaining = length;
  let stopped = false;
  let pending: Promise<Uint8Array> | undefined;
  let closing: Promise<void> | undefined;
  let onAbort: () => void;

  const release = (): Promise<void> => {
    if (!closing) {
      stopped = true;
      signal.removeEventListener('abort', onAbort);
      // A lazy PG handle may still be acquiring its transaction. Closing it
      // before read settles can leave a connection acquired *after* close.
      closing = (async () => {
        await pending?.catch(() => {});
        await handle.close();
      })();
    }
    return closing;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        controller.error(signal.reason);
        void release().catch(() => {});
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      if (stopped) return;
      try {
        if (remaining <= 0) {
          await release();
          controller.close();
          return;
        }
        // Do not use handle.readable: some backends eagerly read the entire
        // file there, even for a small range or a cancelled response.
        pending = handle.read(Math.min(remaining, 64 * 1024), signal);
        const chunk = await pending;
        pending = undefined;
        if (stopped) return;
        remaining -= chunk.length;
        if (chunk.length > 0) controller.enqueue(chunk);
        if (chunk.length === 0 || remaining <= 0) {
          await release();
          controller.close();
        }
      } catch (error) {
        pending = undefined;
        await release();
        controller.error(error);
      }
    },
    cancel: release,
  }, { highWaterMark: 0 });
}
