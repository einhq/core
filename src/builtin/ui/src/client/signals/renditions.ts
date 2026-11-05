/**
 * The rendition table (`RenditionTable` in `@ein/api`), read once as the shell loads, so every page
 * asks for the renditions this installation makes (`lib/derivatives.ts`). Until it is read, or when
 * it cannot be, there are none, and the pages show the originals.
 */

import { signal } from '@preact/signals-react';
import { NO_RENDITIONS, type RenditionTable } from '@ein/api';
import { execCommand } from './shell-client.ts';

export const renditionTable = signal<RenditionTable>(NO_RENDITIONS);

export async function loadRenditions(): Promise<void> {
  try {
    renditionTable.value = await execCommand<RenditionTable>('renditions');
  } catch (error) {
    console.warn('renditions: no rendition table, so the pages show originals', error);
  }
}
