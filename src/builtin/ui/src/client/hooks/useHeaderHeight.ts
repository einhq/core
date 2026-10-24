import { useSignals } from '@preact/signals-react/runtime';
import { stuckHeaderHeight } from '../signals/stuck-header.ts';
import { usePhone } from './usePhone.ts';

/** The fixed AppShell header's height on a desktop. */
export const HEADER_HEIGHT = 48;

/**
 * The header's height on a phone: taller, so its icons can be sized for a
 * thumb rather than a pointer.
 */
export const PHONE_HEADER_HEIGHT = 56;

/**
 * The fixed AppShell header's height in pixels. A stylesheet reads Mantine's
 * `--app-shell-header-height` instead.
 */
export function useAppHeaderHeight(): number {
  return usePhone() ? PHONE_HEADER_HEIGHT : HEADER_HEIGHT;
}

/**
 * How far down the window the headers reach, in pixels, for code that measures
 * what is on screen against it: the fixed AppShell header, and the row of a page
 * header stuck under it (`stuckHeaderHeight`). A stylesheet adds
 * `--mrx-stuck-header-height` to Mantine's `--app-shell-header-height` instead.
 */
export function useHeaderHeight(): number {
  useSignals();
  return useAppHeaderHeight() + stuckHeaderHeight.value;
}
