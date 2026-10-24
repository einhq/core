import { Text } from '@mantine/core';
import { useDisclosure, useElementSize, useMergedRef } from '@mantine/hooks';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Dialog } from '../Surface/Dialog.tsx';
import { Markdown } from '../Markdown/Markdown.tsx';
import { plainMarkdown } from '../../lib/markdown-plain.ts';
import type { HatPattern } from './HatField.tsx';

type HeaderDescriptionProps = {
  text: string;
  /** Heads the full text's dialog: the thing the description is of. */
  heading: ReactNode;
  /** The header's own text colour for it: dimmed under a title, the default in a person's facts. */
  c?: string;
  /** The header's pattern, which the full text's dialog is headed in. */
  pattern?: HatPattern;
};

/**
 * An entity's description in its header, cut to the start of one short line
 * (`.mrx-header-description`), so it neither pushes the title off the cover nor
 * covers the picture: as plain text there, its Markdown marks taken off. When it is
 * cut, it is a button that opens the whole text, as Markdown, in a dialog.
 */
export function HeaderDescription({ text, heading, c, pattern }: HeaderDescriptionProps) {
  const { ref: sizeRef, width, height } = useElementSize<HTMLParagraphElement>();
  const element = useRef<HTMLParagraphElement>(null);
  const ref = useMergedRef(sizeRef, element);
  const [clamped, setClamped] = useState(false);
  const [opened, { open, close }] = useDisclosure();
  const body = plainMarkdown(text);

  useEffect(() => {
    const paragraph = element.current;
    if (paragraph) setClamped(paragraph.scrollWidth > paragraph.clientWidth + 1 || body.includes('\n'));
  }, [width, height, body]);

  // The paragraph itself takes the click rather than a button around it: wrapping it
  // only once it is found cut would remount it and lose the size it is measured by.
  return (
    <>
      <Text
        ref={ref}
        size='sm'
        c={c}
        className='mrx-header-description'
        data-clamped={clamped || undefined}
        role={clamped ? 'button' : undefined}
        tabIndex={clamped ? 0 : undefined}
        title={clamped ? 'Show the whole description' : undefined}
        onClick={clamped ? open : undefined}
        onKeyDown={clamped
          ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              open();
            }
          }
          : undefined}
      >
        {body}
      </Text>
      <Dialog opened={opened} onClose={close} title={heading} icon='align-left' pattern={pattern} size='md'>
        <Markdown content={text} breaks />
      </Dialog>
    </>
  );
}
