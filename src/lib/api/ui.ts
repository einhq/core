/** `ui-notice`: the administrator's note for the sign-in page and Home, `null` when there is none. */
export type UiNotice = {
  /** The first paragraph of `/etc/ui/notice.md`, as Markdown. */
  markdown: string | null;
};
