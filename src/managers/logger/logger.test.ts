import { assertEquals } from '@std/assert';
import { formatArgs } from './logger.ts';

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
