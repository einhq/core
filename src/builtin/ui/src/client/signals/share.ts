import { signal } from '@preact/signals-react';

/**
 * The node whose sharing dialog is open, or `null` when none is.
 *
 * The dialog is held here rather than beside the control that opens it because
 * that control is usually a `Menu.Item`: Mantine unmounts a menu's dropdown
 * when it closes, so a dialog rendered next to the item would be torn down by
 * the same click that opens it.
 */
export const shareModalPath = signal<string | null>(null);

export function openShareModal(path: string) {
  shareModalPath.value = path;
}

export function closeShareModal() {
  shareModalPath.value = null;
}

/**
 * The node whose sharing changed last, and when: a page showing how something is shared — the
 * album's chip — reads it again when it names a node the page shows, or one above it.
 */
export const sharingChanged = signal<{ path: string; at: number } | null>(null);

export function noteSharingChanged(path: string) {
  sharingChanged.value = { path, at: Date.now() };
}
