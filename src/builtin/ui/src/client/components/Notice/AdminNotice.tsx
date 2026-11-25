import { Box } from '@mantine/core';
import type { UiNotice } from '@ein/api';
import { useEffect, useState } from 'react';
import { execFrameCommand } from '../../signals/shell-client.ts';
import { Markdown } from '../Markdown/Markdown.tsx';

/**
 * The administrator's note to whoever opens EiN (`ui-notice`, the first paragraph of
 * /etc/ui/notice.md), as small dimmed Markdown: a web address opens in a new tab, a path is a page
 * of EiN. Nothing while there is none, or while it cannot be read.
 */
export function AdminNotice({ className }: { className?: string }) {
  const [markdown, setMarkdown] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    execFrameCommand<UiNotice>('ui-notice')
      .then((answer) => live && setMarkdown(answer.markdown))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!markdown) return null;
  return (
    <Box className={['mrx-admin-notice', className].filter(Boolean).join(' ')} role='note'>
      <Markdown content={markdown} breaks />
    </Box>
  );
}
