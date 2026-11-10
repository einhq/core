import { assertEquals } from '@std/assert';
import { formatArgs, LOG_FIELD_MAX, logFields } from './logger.ts';

Deno.test('formatArgs writes an Error nested in a context object as its message', () => {
  const err = new TypeError('connection refused');
  assertEquals(
    formatArgs([{ path: '/a.jpg', error: err }]),
    ' {"path":"/a.jpg","error":"TypeError: connection refused"}',
  );
});

Deno.test('formatArgs writes the causes of a nested Error', () => {
  const err = new Error('enqueue failed', { cause: new Error('pool closed') });
  assertEquals(
    formatArgs([{ error: err }]),
    ' {"error":"Error: enqueue failed (cause: Error: pool closed)"}',
  );
});

Deno.test('formatArgs writes a top-level Error as its stack', () => {
  const err = new Error('boom');
  assertEquals(formatArgs([err]), ' ' + err.stack);
});

Deno.test('logFields carries a context object into the system log entry, an Error as its text', () => {
  assertEquals(
    logFields([{ step: 'exif-extract', delayMs: 30000, detail: 'ems: busy', error: new Error('boom'), skipped: undefined }]),
    { step: 'exif-extract', delayMs: 30000, detail: 'ems: busy', error: 'Error: boom' },
  );
});

Deno.test("logFields never replaces the entry's own keys, and gives loose arguments as args", () => {
  assertEquals(logFields([{ level: 'DEBUG', message: 'x', kind: 'ocr' }, 'and', 3]), { kind: 'ocr', args: 'and 3' });
  assertEquals(logFields([new TypeError('refused')]), { error: 'TypeError: refused' });
});

Deno.test('logFields cuts a long field, and keeps a short nested one as it is', () => {
  const fields = logFields([{ detail: 'x'.repeat(LOG_FIELD_MAX + 50), kinds: ['ocr', 'ingest'], big: { text: 'y'.repeat(LOG_FIELD_MAX) } }]);
  assertEquals((fields.detail as string).length, LOG_FIELD_MAX);
  assertEquals(fields.kinds, ['ocr', 'ingest']);
  assertEquals(typeof fields.big, 'string');
  assertEquals((fields.big as string).length, LOG_FIELD_MAX);
});
