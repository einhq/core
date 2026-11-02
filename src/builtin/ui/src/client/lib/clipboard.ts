/**
 * Put `text` on the clipboard. The Clipboard API exists only on a secure page, and EiN is often
 * reached over plain HTTP on the home network: there the shown link is selected and copied the
 * older way, which still works, and is left selected for Ctrl+C when even that is refused.
 */
export async function copyText(text: string, input: HTMLInputElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused: fall through to the selection.
  }
  input?.focus();
  input?.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  }
}
