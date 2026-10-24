import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderText } from '@codemirror/view';
import { ActionIcon, Box, Group, Input, SegmentedControl, Text, Tooltip } from '@mantine/core';
import { tags } from '@lezer/highlight';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import { Markdown } from './Markdown.tsx';

export type MarkdownEditorProps = {
  label?: string;
  /** A hint under the label, as on Mantine's inputs. */
  description?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  /** Take the focus when a dialog holding it opens (Mantine's `data-autofocus`). */
  autoFocus?: boolean;
  /** How many lines of text the box is tall before it grows with its text. */
  minRows?: number;
};

/** Wrap each selection in `mark` (`**`, `_`, `` ` ``), or take it off one already wrapped; an empty one gets the pair with the cursor inside. */
function toggleWrap(view: EditorView, mark: string): boolean {
  const { state } = view;
  const n = mark.length;
  view.dispatch(state.changeByRange((range) => {
    const before = state.sliceDoc(range.from - n, range.from);
    const after = state.sliceDoc(range.to, range.to + n);
    if (before === mark && after === mark) {
      return {
        changes: [{ from: range.from - n, to: range.from }, { from: range.to, to: range.to + n }],
        range: EditorSelection.range(range.from - n, range.to - n),
      };
    }
    return {
      changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
      range: EditorSelection.range(range.from + n, range.to + n),
    };
  }));
  view.focus();
  return true;
}

/**
 * Start every line the selection touches with `prefix`, or take it off when they all have it.
 * A numbered list counts its lines up from 1.
 */
function toggleLinePrefix(view: EditorView, prefix: string | 'numbered'): boolean {
  const { state } = view;
  const lines = new Map<number, { from: number; text: string }>();
  for (const range of state.selection.ranges) {
    for (let at = range.from; at <= range.to;) {
      const line = state.doc.lineAt(at);
      lines.set(line.number, { from: line.from, text: line.text });
      at = line.to + 1;
    }
  }
  const marker = (index: number) => prefix === 'numbered' ? `${index + 1}. ` : prefix;
  const present = (text: string) => prefix === 'numbered' ? /^\d+\. /.exec(text)?.[0] : text.startsWith(prefix) ? prefix : undefined;
  const all = [...lines.values()];
  const remove = all.every((line) => present(line.text));
  view.dispatch({
    changes: all.map((line, index) => remove ? { from: line.from, to: line.from + present(line.text)!.length } : { from: line.from, insert: marker(index) }),
  });
  view.focus();
  return true;
}

/** Make the selection a link's text (or `text` when nothing is selected) and select its address to be typed over. */
function insertLink(view: EditorView): boolean {
  const { state } = view;
  view.dispatch(state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to) || 'text';
    const start = range.from + text.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert: `[${text}](https://)` },
      range: EditorSelection.range(start, start + 'https://'.length),
    };
  }));
  view.focus();
  return true;
}

type Tool = { icon: string; label: string; keys?: string; run: (view: EditorView) => boolean };

const TOOLS: Tool[][] = [
  [
    { icon: 'bold', label: 'Bold', keys: 'Mod-b', run: (view) => toggleWrap(view, '**') },
    { icon: 'italic', label: 'Italic', keys: 'Mod-i', run: (view) => toggleWrap(view, '_') },
    { icon: 'strikethrough', label: 'Strikethrough', run: (view) => toggleWrap(view, '~~') },
    { icon: 'code', label: 'Code', keys: 'Mod-e', run: (view) => toggleWrap(view, '`') },
  ],
  [
    { icon: 'heading', label: 'Heading', run: (view) => toggleLinePrefix(view, '## ') },
    { icon: 'quote', label: 'Quote', run: (view) => toggleLinePrefix(view, '> ') },
    { icon: 'list', label: 'Bulleted list', run: (view) => toggleLinePrefix(view, '- ') },
    { icon: 'list-numbers', label: 'Numbered list', run: (view) => toggleLinePrefix(view, 'numbered') },
    { icon: 'link', label: 'Link', keys: 'Mod-k', run: insertLink },
  ],
];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const keyLabel = (keys: string) => `${isMac ? '⌘' : 'Ctrl+'}${keys.slice('Mod-'.length).toUpperCase()}`;

/** The source shown as it will read: marks dimmed, emphasis and headings as they render, in Mantine's colours for either scheme. */
const sourceStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700' },
  { tag: tags.heading1, fontSize: '1.25em' },
  { tag: tags.heading2, fontSize: '1.15em' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--mantine-color-anchor)' },
  { tag: tags.url, color: 'var(--mantine-color-anchor)', textDecoration: 'underline' },
  { tag: tags.monospace, fontFamily: 'var(--mantine-font-family-monospace)' },
  { tag: tags.quote, color: 'var(--mantine-color-dimmed)', fontStyle: 'italic' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName], color: 'var(--mantine-color-dimmed)' },
]);

const editorTheme = (minRows: number) =>
  EditorView.theme({
    '&': { fontSize: 'var(--mantine-font-size-sm)', backgroundColor: 'transparent', color: 'var(--mantine-color-text)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--mantine-font-family)', lineHeight: '1.55', maxHeight: '24rem', overflow: 'auto' },
    '.cm-content': { padding: '8px 12px', minHeight: `calc(${minRows} * 1.55em + 16px)`, caretColor: 'var(--mantine-color-text)' },
    '.cm-line': { padding: '0' },
    '.cm-placeholder': { color: 'var(--mantine-color-placeholder)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--mantine-primary-color-light)' },
  });

/**
 * A field for Markdown text: the source with its marks shown as they will read, a toolbar for
 * emphasis, headings, lists, quotes and links (with the usual keys for the first few), and a
 * preview of the text as the archive shows it.
 */
export function MarkdownEditor({ label, description, value, onChange, placeholder, required, autoFocus = false, minRows = 4 }: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([
            ...TOOLS.flat().flatMap((tool) => tool.keys ? [{ key: tool.keys, run: tool.run, preventDefault: true }] : []),
            // Enter is a new line here, so the form around it is sent with Mod-Enter.
            {
              key: 'Mod-Enter',
              run: (editor) => {
                editor.dom.closest('form')?.requestSubmit();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdown(),
          syntaxHighlighting(sourceStyle),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': label ?? 'Markdown',
            spellcheck: 'true',
            autocapitalize: 'sentences',
            ...(autoFocus ? { 'data-autofocus': 'true' } : {}),
          }),
          editorTheme(minRows),
          ...(placeholder ? [placeholderText(placeholder)] : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
            if (update.focusChanged) setFocused(update.view.hasFocus);
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The options are captured once; the text follows `value` below.
  }, []);

  // A change from outside (the dialog reopened on another text) replaces the document; the
  // editor's own edits echo back equal and leave the cursor where it is.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value) editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  const writing = mode === 'write';
  const borderColor = focused && writing ? 'var(--mantine-primary-color-filled)' : 'var(--mantine-color-default-border)';

  return (
    <Input.Wrapper label={label} description={description} required={required}>
      <Box style={{ border: `1px solid ${borderColor}`, borderRadius: 'var(--mantine-radius-sm)', background: 'var(--mantine-color-body)', overflow: 'hidden' }}>
        <Group
          gap={4}
          px={6}
          py={4}
          wrap='nowrap'
          style={{ borderBottom: '1px solid var(--mantine-color-default-border)', background: 'var(--mantine-color-default-hover)' }}
        >
          <Group gap={2} wrap='wrap' style={{ flex: 1, minWidth: 0, visibility: writing ? 'visible' : 'hidden' }}>
            {TOOLS.map((group, index) => (
              <Group
                key={index}
                gap={0}
                wrap='nowrap'
                pr={4}
                mr={2}
                style={index < TOOLS.length - 1 ? { borderRight: '1px solid var(--mantine-color-default-border)' } : undefined}
              >
                {group.map((tool) => (
                  <Tooltip key={tool.icon} label={tool.keys ? `${tool.label} (${keyLabel(tool.keys)})` : tool.label} openDelay={400} withinPortal>
                    <ActionIcon
                      variant='subtle'
                      color='gray'
                      size='md'
                      aria-label={tool.label}
                      // Keep the editor's selection: a click on the button would otherwise take focus first.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => view.current && tool.run(view.current)}
                    >
                      <TablerIcon name={tool.icon} size={16} />
                    </ActionIcon>
                  </Tooltip>
                ))}
              </Group>
            ))}
          </Group>
          <SegmentedControl
            size='xs'
            value={mode}
            onChange={(next) => setMode(next as 'write' | 'preview')}
            data={[{ value: 'write', label: 'Write' }, { value: 'preview', label: 'Preview' }]}
          />
        </Group>
        {/* Hidden rather than unmounted while previewing, so the undo history and cursor survive. */}
        <div ref={host} style={{ display: writing ? undefined : 'none' }} />
        {!writing && (
          <Box px={12} py={8} mih={`calc(${minRows} * 1.55em + 16px)`} fz='sm' style={{ maxHeight: '24rem', overflow: 'auto' }}>
            {value.trim() ? <Markdown content={value} /> : <Text size='sm' c='dimmed'>Nothing to preview</Text>}
          </Box>
        )}
      </Box>
    </Input.Wrapper>
  );
}
