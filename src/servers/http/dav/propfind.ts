/**
 * PROPFIND: the properties of a node and, below depth 0, of its children, as one multistatus.
 *
 * Only live properties are kept: the name, whether it is a collection, and a file's length, type,
 * ETag and times. A file is never a collection, so its own nodes (its EXIF, faces and thumbnails)
 * are not listed; a softlink is listed as what it points to, and left out when that cannot be read.
 */

import { join } from '@std/path';
import type { Access } from '../../../lib/access/mod.ts';
import { createLogger } from '../../../managers/logger/mod.ts';
import type { Node, NodeChildEntry, NodeVFS } from '../../../vfs/mod.ts';
import { contentTime } from '../../../vfs/types/file.ts';
import { isClientFile } from '../../client-files.ts';
import { davHref } from './paths.ts';
import { DAV_NS, isElement, MAX_PROPERTIES, MULTISTATUS_CLOSE, MULTISTATUS_OPEN, propElement, type PropName, propstat, type XmlElement, XmlError, xmlEscape } from './xml.ts';

const logger = createLogger('dav');

/** Children read per page of a listing. */
const PAGE = 500;

/** What a PROPFIND asks for: every property with its value, every property's name, or these. */
type PropRequest = { kind: 'allprop' } | { kind: 'propname' } | { kind: 'prop'; props: PropName[] };

/**
 * The request a PROPFIND body makes; an empty body asks for every property (RFC 4918, 9.1).
 * @throws XmlError when the document is not a propfind
 */
export function propRequest(body: XmlElement | undefined): PropRequest {
  if (!body) return { kind: 'allprop' };
  if (!isElement(body, DAV_NS, 'propfind')) throw new XmlError('not a propfind');
  for (const child of body.children) {
    if (isElement(child, DAV_NS, 'allprop')) return { kind: 'allprop' };
    if (isElement(child, DAV_NS, 'propname')) return { kind: 'propname' };
    if (isElement(child, DAV_NS, 'prop')) {
      if (child.children.length > MAX_PROPERTIES) throw new XmlError(`more than ${MAX_PROPERTIES} properties asked for`);
      return { kind: 'prop', props: child.children.map(({ ns, name }) => ({ ns, name })) };
    }
  }
  throw new XmlError('a propfind that asks for nothing');
}

/**
 * A file's ETag, its content's SHA-256, quoted; undefined when it has none. Only a hash goes out:
 * the attr is a member's to set, and anything else would be written into an answer as it is.
 */
export function etagOf(attrs: { sha256?: unknown }): string | undefined {
  return typeof attrs.sha256 === 'string' && /^[0-9a-f]{64}$/.test(attrs.sha256) ? `"${attrs.sha256}"` : undefined;
}

/** A node's live properties, each with its value written out; those it lacks are absent. */
function liveProps(node: Node, name: string, collection: boolean): Map<string, string> {
  const props = new Map<string, string>();
  props.set('displayname', xmlEscape(name));
  props.set('resourcetype', collection ? '<D:collection/>' : '');
  props.set('getlastmodified', new Date(contentTime(node)).toUTCString());
  const born = node.props.birthtime?.timestamp;
  if (born !== undefined) props.set('creationdate', new Date(born).toISOString());
  if (!collection) {
    const attrs = node.attrs as { size?: unknown; mimetype?: unknown; sha256?: unknown };
    props.set('getcontentlength', String(typeof attrs.size === 'number' ? attrs.size : 0));
    if (typeof attrs.mimetype === 'string' && attrs.mimetype !== '') props.set('getcontenttype', xmlEscape(attrs.mimetype));
    const etag = etagOf(attrs);
    if (etag) props.set('getetag', etag);
  }
  return props;
}

/** One resource's `<D:response>`. */
function propResponse(path: string, node: Node, request: PropRequest): string {
  const collection = !isClientFile(node);
  const name = path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1);
  const live = liveProps(node, name, collection);
  const found: string[] = [];
  const missing: string[] = [];
  if (request.kind === 'propname') {
    for (const prop of live.keys()) found.push(propElement({ ns: DAV_NS, name: prop }));
  } else if (request.kind === 'allprop') {
    for (const [prop, value] of live) found.push(propElement({ ns: DAV_NS, name: prop }, value));
  } else {
    for (const prop of request.props) {
      const value = prop.ns === DAV_NS ? live.get(prop.name) : undefined;
      if (value === undefined) missing.push(propElement(prop));
      else found.push(propElement(prop, value));
    }
  }
  return `<D:response><D:href>${xmlEscape(davHref(path, collection))}</D:href>` +
    (found.length > 0 || missing.length === 0 ? propstat(found, 200, 'OK') : '') +
    (missing.length > 0 ? propstat(missing, 404, 'Not Found') : '') +
    '</D:response>';
}

/** The first page of a collection's children, which a PROPFIND reads before it answers, so a refusal is its status. */
export const firstPage = (vfs: NodeVFS, access: Access, path: string): Promise<NodeChildEntry[]> => vfs.children(access, path, { page: { limit: PAGE } });

/**
 * The multistatus for `node` at `path` and, after it, the children in `first` and every page that
 * follows it, read and written one at a time.
 */
export function propfindBody(vfs: NodeVFS, access: Access, path: string, node: Node, request: PropRequest, first?: NodeChildEntry[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let page = first;
  let started = false;

  const responses = async (entries: NodeChildEntry[]): Promise<string> => {
    const parts: string[] = [];
    for (const child of entries) {
      const childPath = join(path, child.name);
      const shown = child.node.props.softlink ? await vfs.get(access, childPath).catch(() => undefined) : child.node;
      if (shown) parts.push(propResponse(childPath, shown, request));
    }
    return parts.join('');
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(MULTISTATUS_OPEN + propResponse(path, node, request)));
        return;
      }
      if (!page) {
        controller.enqueue(encoder.encode(MULTISTATUS_CLOSE));
        controller.close();
        return;
      }
      const entries = page;
      try {
        controller.enqueue(encoder.encode(await responses(entries)));
        page = entries.length < PAGE ? undefined : await vfs.children(access, path, { page: { limit: PAGE, after: entries[entries.length - 1].name } });
      } catch (error) {
        // The status went out with the first part; an error now can only end the listing short.
        logger.warn('PROPFIND listing ended early', { path, error: error instanceof Error ? error.message : String(error) });
        page = undefined;
      }
    },
  });
}
