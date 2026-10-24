import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { defaultHighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { useComputedColorScheme } from '@mantine/core';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';
import type { CodeLanguage } from '../../lib/code-language.ts';

export type CodeMirrorProps = {
  value: string;
  /** Called on every edit; absent for a viewer. */
  onChange?: (value: string) => void;
  language?: CodeLanguage;
  readOnly?: boolean;
  autoFocus?: boolean;
  /** CSS height of the editor box; the document scrolls inside it. */
  height?: string;
  /**
   * `editor` is the full thing: gutters, line numbers, folding, the keymap. `block` is a
   * highlighted snippet in running text — no gutter, wrapped lines, the height of its lines —
   * for a command shown in a chat card.
   */
  chrome?: 'editor' | 'block';
  /** A border around the box; off where the surrounding card already frames it. */
  framed?: boolean;
};

/**
 * The language extensions are imported statically, every one of them, because
 * the UI bundle is one file: `deno bundle` here does no code splitting, so a
 * lazy `import()` would not save a byte and would add a loading state.
 */
const languageExtension = (language: CodeLanguage): Extension => {
  switch (language) {
    case 'json':
      return json();
    case 'javascript':
      return javascript({ jsx: true });
    case 'typescript':
      return javascript({ jsx: true, typescript: true });
    case 'yaml':
      return yaml();
    case 'markdown':
      return markdown();
    case 'html':
      return html();
    case 'css':
      return css();
    case 'xml':
      return xml();
    case 'shell':
      return StreamLanguage.define(shell);
    case 'text':
      return [];
  }
};

/** Light scheme: Mantine's own colours around CodeMirror's default highlighting. */
const lightTheme: Extension = [
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  EditorView.theme({
    '&': { backgroundColor: 'var(--mantine-color-white)', color: 'var(--mantine-color-black)' },
    '.cm-gutters': { backgroundColor: 'var(--mantine-color-gray-0)', color: 'var(--mantine-color-dimmed)', borderRight: '1px solid var(--mantine-color-gray-3)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--mantine-color-gray-1)' },
    '.cm-activeLine': { backgroundColor: 'var(--mantine-color-gray-0)' },
  }),
];

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--mantine-font-family-monospace)', overflow: 'auto' },
  '&.cm-focused': { outline: 'none' },
});

const blockTheme = EditorView.theme({
  '&': { fontSize: '12px', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'var(--mantine-font-family-monospace)', overflow: 'visible', lineHeight: '1.5' },
  '.cm-content': { padding: '6px 8px' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
});

/**
 * A CodeMirror 6 view as a React control.
 *
 * The view is created once per mount; language, theme and read-only state are
 * compartments reconfigured in place, and an outside `value` change replaces
 * the document only when it differs from what the view holds, so the caller's
 * own edits echoed back through `value` do not move the cursor.
 */
export function CodeMirror({ value, onChange, language = 'text', readOnly = false, autoFocus = false, height = '100%', chrome = 'editor', framed = true }: CodeMirrorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const compartments = useRef({ language: new Compartment(), theme: new Compartment(), readOnly: new Compartment() });
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const scheme = useComputedColorScheme('light');

  useEffect(() => {
    if (!host.current) return;
    const { language: lang, theme, readOnly: ro } = compartments.current;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...(chrome === 'editor'
            ? [basicSetup, keymap.of([indentWithTab]), baseTheme]
            // A block may still be typed in (a proposed command tweaked before it runs): the keys and undo, no chrome.
            : [EditorView.lineWrapping, blockTheme, history(), keymap.of([...defaultKeymap, ...historyKeymap])]),
          lang.of(languageExtension(language)),
          theme.of(scheme === 'dark' ? oneDark : lightTheme),
          ro.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    if (autoFocus) editor.focus();
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The initial document and options are captured here; later changes go through the effects below.
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.language.reconfigure(languageExtension(language)) });
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.theme.reconfigure(scheme === 'dark' ? oneDark : lightTheme) });
  }, [scheme]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.readOnly.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return (
    <div
      ref={host}
      style={{
        height,
        minHeight: 0,
        overflow: 'hidden',
        ...(framed ? { border: '1px solid var(--mantine-color-default-border)', borderRadius: 'var(--mantine-radius-sm)' } : {}),
      }}
    />
  );
}
