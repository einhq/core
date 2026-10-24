import { signal } from '@preact/signals-react';
import type { CodeLanguage } from '../lib/code-language.ts';

/**
 * What the code editor dialog is asked to show.
 *
 * A `file` is a VFS node: the dialog reads its bytes from `/file` and writes
 * them back the same way. A `text` is a string the caller already holds —
 * attributes as JSON, a draft — and the caller's `onSave` decides where it
 * goes; without one it is read-only.
 */
export type CodeEditorRequest =
  | {
    kind: 'file';
    path: string;
    /** Shown instead of the path's last segment. */
    title?: string;
    /** Forced read-only; otherwise the caller's permission judgement applies. */
    readOnly?: boolean;
    /** Overrides the language guessed from the node's mimetype and name. */
    language?: CodeLanguage;
    /** The node's mimetype, so the guess does not need a lookup of its own. */
    mimetype?: string;
  }
  | {
    kind: 'text';
    title: string;
    value: string;
    language?: CodeLanguage;
    readOnly?: boolean;
    onSave?: (value: string) => Promise<void>;
  };

/**
 * The open request, or `null` when the dialog is closed.
 *
 * Held here rather than beside the control that opens the editor: that is
 * usually a `Menu.Item`, and Mantine unmounts a menu's dropdown, with anything
 * rendered beside the item, on the same click.
 */
export const codeEditorRequest = signal<CodeEditorRequest | null>(null);

export function openCodeEditor(request: CodeEditorRequest) {
  codeEditorRequest.value = request;
}

export function closeCodeEditor() {
  codeEditorRequest.value = null;
}
