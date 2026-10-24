/**
 * A failed step's `error` attr keeps both ends of its output: a noisy first tool
 * cannot push the step's own verdict, written last, out of the window. The
 * engine and the pool worker go through the same window.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { elide, STEP_ERROR_HEAD, STEP_ERROR_TAIL, STEP_LOG_HEAD, STEP_LOG_TAIL, stepErrorDetail, stepErrorLogDetail } from '../step-error.ts';

Deno.test('output within the window is kept whole', () => {
  const out = 'ffmpeg: no such file or directory';
  assertEquals(stepErrorDetail(1, '', out), out);
  assertEquals(elide(out, out.length - 1, 1), out, 'a window that exactly spans the text elides nothing');
});

Deno.test('an oversized output keeps its head and its tail', () => {
  const banner = 'x'.repeat(4000);
  const cause = 'video-to-video: a CPU decode of 125675 frames projects to 21364MB, over the 4000MB budget';
  const detail = stepErrorDetail(1, '', `${banner}\n${cause}`);

  assertStringIncludes(detail, 'xxxx');
  assertStringIncludes(detail, cause, 'the cause is written last, so the tail is what has to survive');
  assertStringIncludes(detail, 'characters elided');
  assert(detail.length < STEP_ERROR_HEAD + STEP_ERROR_TAIL + 64, `detail is ${detail.length} characters`);
});

Deno.test('the elision marker counts what it dropped', () => {
  const detail = stepErrorDetail(1, '', 'y'.repeat(STEP_ERROR_HEAD + STEP_ERROR_TAIL + 500));
  assertStringIncludes(detail, '… 500 characters elided …');
});

Deno.test('stderr wins over stdout, and an exit code stands in for silence', () => {
  assertEquals(stepErrorDetail(1, 'progress', 'boom'), 'boom');
  assertEquals(stepErrorDetail(1, 'progress', '   '), 'progress');
  assertEquals(stepErrorDetail(124, '', ''), 'exit 124');
});

Deno.test('the log detail keeps both ends within a narrower window', () => {
  const cause = 'cannot identify image file';
  const logDetail = stepErrorLogDetail(1, '', `${'z'.repeat(3000)}\n${cause}`);

  assertStringIncludes(logDetail, cause, 'a transcribe-file failure logged as {step,code} alone is what this line is for');
  assert(logDetail.length < STEP_LOG_HEAD + STEP_LOG_TAIL + 64, `log detail is ${logDetail.length} characters`);
  assert(STEP_LOG_HEAD + STEP_LOG_TAIL < STEP_ERROR_HEAD + STEP_ERROR_TAIL, 'the log line is the cheaper of the two');
});
