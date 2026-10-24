/**
 * Where "Open" on an explorer row leads.
 *
 * Drilling in is the default for every node, since every node may have
 * children. "Open" is the other thing: the page or viewer that already knows
 * how to show this kind of node — the route a module gives its type
 * (`ui.open`). A media file opens in the lightbox, a text file in the code
 * editor, anything else with bytes in a new tab.
 */
import { type AccessIds, canWrite } from './access.ts';
import { isTextLike } from './code-language.ts';
import { fileUrl } from './file-url.ts';
import { isMediaFile, type NodeChildEntry } from './node-entry.ts';
import { baseName } from './node-path.ts';
import { openRoute } from '../signals/module-ui.ts';

export type OpenTarget =
  | { kind: 'route'; to: string }
  | { kind: 'lightbox' }
  /** The code editor; `readOnly` is the client's guess from mode and owner, the server decides for real. */
  | { kind: 'editor'; readOnly: boolean }
  | { kind: 'file'; url: string }
  | { kind: 'none' };

export function openTargetFor(entry: Pick<NodeChildEntry, 'node'>, path: string, access: AccessIds | null): OpenTarget {
  const { type } = entry.node;
  const route = openRoute(type, path);
  if (route) return { kind: 'route', to: route };
  if (type === 'file') {
    if (isMediaFile(entry as NodeChildEntry)) return { kind: 'lightbox' };
    if (isTextLike(entry.node.attrs.mimetype, baseName(path))) return { kind: 'editor', readOnly: !canWrite(entry.node.props, access) };
    return { kind: 'file', url: fileUrl(path) };
  }
  return { kind: 'none' };
}
