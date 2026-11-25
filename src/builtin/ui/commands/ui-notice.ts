import type { CmdReturn, Command } from '@ein/client';
import { collectUnknownFlags, NodeNotFoundError, parseArgs, reportUnknownFlags } from '@ein/client';
import type { UiNotice } from '@ein/api';
import { UI_NOTICE_PATH } from '@ein/paths';
import { toText } from '@std/streams/to-text';

/** A Markdown text's first paragraph: its lines up to the first blank one, after any blank ones it opens with. */
export const firstParagraph = (markdown: string): string => markdown.replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n/)[0].trim();

export const uiNotice = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { boolean: ['help'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  if (flags.help) {
    await cmd.writeLn(
      `usage: ui-notice\nThe administrator's note to whoever opens EiN: the first paragraph of ${UI_NOTICE_PATH}, which the sign-in page and Home show. Nothing when the file is not there or is empty.`,
    );
    return 0;
  }

  // Read as the caller, the guest included: the file is the administrator's, and its mode says who sees it.
  let markdown: string | null = null;
  try {
    const handle = await cmd.sys.vfs.open(cmd.access, UI_NOTICE_PATH, { mode: 'r' });
    try {
      markdown = firstParagraph(await toText(handle.readable)) || null;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(error instanceof NodeNotFoundError)) {
      await cmd.writeError(`ui-notice: ${UI_NOTICE_PATH}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  if (cmd.json) {
    await cmd.writeJSON({ markdown } satisfies UiNotice);
    return 0;
  }
  if (markdown) await cmd.writeLn(markdown);
  return 0;
};

uiNotice.spec = {
  name: 'ui-notice',
  // The sign-in page shows it before anyone has signed in.
  guest: true,
  effect: 'read' as const,
  description: "The administrator's note to whoever opens EiN, which the sign-in page and Home show: the first paragraph of /etc/ui/notice.md",
  args: [],
  flags: [],
};
