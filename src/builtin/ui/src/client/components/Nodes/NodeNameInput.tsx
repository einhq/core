import { TextInput } from '@mantine/core';
import { type SyntheticEvent, useEffect, useRef, useState } from 'react';
import { nameProblem } from '../../lib/node-path.ts';

type NodeNameInputProps = {
  name: string;
  /** Called once with a changed, valid name; the field stays, read-only, until the row is redrawn. */
  onCommit: (name: string) => void;
  /** Called once when editing ends without a rename: Escape, or leaving an unchanged or invalid name. */
  onCancel: () => void;
  centered?: boolean;
};

/**
 * A row's name, being renamed where it stands.
 *
 * Enter or leaving the field renames and Escape does not, as in every file
 * manager. The field sits inside a tree item whose own handlers want the
 * arrow keys, Space, clicks and drags, so every event stops here: inside the
 * field they mean text editing, not moving through the tree.
 */
export function NodeNameInput({ name, onCommit, onCancel, centered = false }: NodeNameInputProps) {
  const [draft, setDraft] = useState(name);
  const [committed, setCommitted] = useState(false);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const problem = nameProblem(draft);

  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus();
    // The stem, not the extension: renaming a photo rarely means retyping `.jpg`.
    const dot = name.lastIndexOf('.');
    field.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [name]);

  const finish = (rename: boolean) => {
    if (done.current) return;
    done.current = true;
    if (rename && !problem && draft !== name) {
      setCommitted(true);
      onCommit(draft);
    } else onCancel();
  };

  const stop = (event: SyntheticEvent) => event.stopPropagation();

  return (
    <TextInput
      ref={input}
      size='xs'
      value={draft}
      readOnly={committed}
      error={problem !== null}
      title={problem ?? undefined}
      aria-label='Name'
      spellCheck={false}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          if (!problem) finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      onClick={stop}
      onDoubleClick={stop}
      onMouseDown={stop}
      onContextMenu={stop}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{ flex: 1, minWidth: 0, width: centered ? '100%' : undefined }}
      styles={{ input: { height: 22, minHeight: 22, paddingInline: 4, fontFamily: 'var(--mantine-font-family-monospace)', textAlign: centered ? 'center' : undefined } }}
    />
  );
}
