/**
 * The XML WebDAV speaks: request bodies read into elements with their namespaces resolved, and
 * multistatus answers written out.
 *
 * The reader takes the small documents PROPFIND and PROPPATCH send and nothing more. It refuses a
 * document type and every other `<!` declaration, so no entity is ever defined or expanded, knows
 * only the five predefined entities and character references, and stops at a depth and an element
 * count no client's request comes near.
 */

/** The WebDAV namespace. */
export const DAV_NS = 'DAV:';

/** An element as read: its namespace (empty for none), local name, child elements and text. */
export type XmlElement = { ns: string; name: string; children: XmlElement[]; text: string };

/** A document that is not XML this reader takes; answered 400. */
export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

const MAX_DEPTH = 64;
const MAX_ELEMENTS = 10_000;
const MAX_ATTRIBUTES = 64;
const MAX_NAME = 256;
const MAX_NAMESPACE = 1024;

/** The most properties one PROPFIND or PROPPATCH may name: an answer repeats each per resource. */
export const MAX_PROPERTIES = 100;

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const NAME = /^[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?$/;

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

const isSpace = (char: string): boolean => char === ' ' || char === '\t' || char === '\n' || char === '\r';

/** `text` with its entity and character references replaced. */
function decodeReferences(text: string): string {
  return text.replace(/&([^;&\s]*);?/g, (whole, ref: string) => {
    if (!whole.endsWith(';')) throw new XmlError(`an unterminated reference: ${whole}`);
    if (ref.startsWith('#x') || ref.startsWith('#X')) return codePoint(parseInt(ref.slice(2), 16), whole);
    if (ref.startsWith('#')) return codePoint(parseInt(ref.slice(1), 10), whole);
    const value = PREDEFINED[ref];
    if (value === undefined) throw new XmlError(`an unknown entity: ${whole}`);
    return value;
  });
}

function codePoint(value: number, ref: string): string {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    throw new XmlError(`not a character: ${ref}`);
  }
  return String.fromCodePoint(value);
}

/** An element still open, with the namespaces it declares itself, if any. */
type Open = { qname: string; element: XmlElement; declared?: Map<string, string> };

/**
 * The namespace `prefix` names where an element declaring `declared` stands below the open
 * elements `stack`: its own declaration, else the innermost ancestor's. Looked up rather than
 * copied into every element, so a document of many declarations costs no more than one of few.
 */
function lookup(prefix: string, declared: Map<string, string> | undefined, stack: Open[]): string | undefined {
  const own = declared?.get(prefix);
  if (own !== undefined) return own;
  for (let i = stack.length - 1; i >= 0; i--) {
    const value = stack[i].declared?.get(prefix);
    if (value !== undefined) return value;
  }
  return prefix === 'xml' ? XML_NS : undefined;
}

/**
 * Read `text` as one XML document: its root element with namespaces resolved.
 * @throws XmlError
 */
export function parseXml(text: string): XmlElement {
  let at = 0;
  const stack: Open[] = [];
  let root: XmlElement | undefined;
  let count = 0;

  const fail = (message: string): never => {
    throw new XmlError(message);
  };

  const skipUntil = (end: string, what: string): void => {
    const found = text.indexOf(end, at);
    if (found < 0) fail(`an unterminated ${what}`);
    at = found + end.length;
  };

  if (text.startsWith('\uFEFF')) at = 1;
  const declaration = /^<\?xml\s[^?]*\?>/.exec(text.slice(at));
  if (declaration) {
    const encoding = /encoding\s*=\s*["']([^"']*)["']/.exec(declaration[0]);
    if (encoding && !/^utf-?8$/i.test(encoding[1])) fail(`an encoding other than UTF-8: ${encoding[1]}`);
    at += declaration[0].length;
  }

  while (at < text.length) {
    const lt = text.indexOf('<', at);
    const chunk = text.slice(at, lt < 0 ? text.length : lt);
    if (stack.length > 0) stack[stack.length - 1].element.text += decodeReferences(chunk);
    else if (chunk.trim() !== '') fail('text outside the root element');
    if (lt < 0) break;
    at = lt;

    if (text.startsWith('<!--', at)) {
      skipUntil('-->', 'comment');
      continue;
    }
    if (text.startsWith('<![CDATA[', at)) {
      if (stack.length === 0) fail('CDATA outside the root element');
      const end = text.indexOf(']]>', at);
      if (end < 0) fail('an unterminated CDATA section');
      stack[stack.length - 1].element.text += text.slice(at + 9, end);
      at = end + 3;
      continue;
    }
    if (text.startsWith('<!', at)) fail('a document type or declaration, which is not taken');
    if (text.startsWith('<?', at)) {
      skipUntil('?>', 'processing instruction');
      continue;
    }

    if (text.startsWith('</', at)) {
      const end = text.indexOf('>', at);
      if (end < 0) fail('an unterminated end tag');
      const qname = text.slice(at + 2, end).trim();
      const open = stack.pop();
      if (!open || open.qname !== qname) fail(`an end tag that closes nothing open: </${qname}>`);
      at = end + 1;
      continue;
    }

    // A start tag: its name, its attributes, and whether it closes itself. Scanned by hand, each
    // character once: a regular expression over a tag's attributes backtracks on a long malformed one.
    let i = at + 1;
    while (i < text.length && !isSpace(text[i]) && text[i] !== '/' && text[i] !== '>') i++;
    const qname = text.slice(at + 1, i);
    if (qname.length > MAX_NAME || !NAME.test(qname)) fail(`a malformed name: ${qname.slice(0, MAX_NAME)}`);
    if (root && stack.length === 0) fail('content after the root element');
    if (stack.length >= MAX_DEPTH) fail(`more than ${MAX_DEPTH} levels`);
    if (++count > MAX_ELEMENTS) fail(`more than ${MAX_ELEMENTS} elements`);

    let declared: Map<string, string> | undefined;
    let attributes = 0;
    let selfClosing = false;
    for (;;) {
      while (i < text.length && isSpace(text[i])) i++;
      if (i >= text.length) fail(`an unterminated tag: <${qname}>`);
      if (text[i] === '>') {
        i++;
        break;
      }
      if (text[i] === '/') {
        if (text[i + 1] !== '>') fail(`a malformed tag: <${qname}>`);
        i += 2;
        selfClosing = true;
        break;
      }
      if (++attributes > MAX_ATTRIBUTES) fail(`more than ${MAX_ATTRIBUTES} attributes on <${qname}>`);
      const nameAt = i;
      while (i < text.length && !isSpace(text[i]) && text[i] !== '=' && text[i] !== '/' && text[i] !== '>') i++;
      const name = text.slice(nameAt, i);
      if (name.length > MAX_NAME || !NAME.test(name)) fail(`a malformed attribute name: ${name.slice(0, MAX_NAME)}`);
      while (i < text.length && isSpace(text[i])) i++;
      if (text[i] !== '=') fail(`an attribute without a value: ${name}`);
      i++;
      while (i < text.length && isSpace(text[i])) i++;
      const quote = text[i];
      if (quote !== '"' && quote !== "'") fail(`an unquoted attribute value: ${name}`);
      const end = text.indexOf(quote, i + 1);
      if (end < 0) fail(`an unterminated attribute value: ${name}`);
      const value = decodeReferences(text.slice(i + 1, end));
      i = end + 1;
      if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
      if (value.length > MAX_NAMESPACE) fail(`a namespace longer than ${MAX_NAMESPACE} characters`);
      if (name.startsWith('xmlns:') && value === '') fail(`a prefix bound to no namespace: ${name}`);
      (declared ??= new Map()).set(name === 'xmlns' ? '' : name.slice(6), value);
    }

    const colon = qname.indexOf(':');
    const prefix = colon < 0 ? '' : qname.slice(0, colon);
    const ns = lookup(prefix, declared, stack);
    if (ns === undefined && prefix !== '') fail(`an undeclared prefix: ${prefix}`);
    const element: XmlElement = { ns: ns ?? '', name: colon < 0 ? qname : qname.slice(colon + 1), children: [], text: '' };

    if (stack.length > 0) stack[stack.length - 1].element.children.push(element);
    else root = element;
    if (!selfClosing) stack.push({ qname, element, declared });
    at = i;
  }

  if (stack.length > 0) fail(`an element left open: <${stack[stack.length - 1].qname}>`);
  if (!root) fail('no root element');
  return root!;
}

/** Whether `element` is `name` in `ns`. */
export const isElement = (element: XmlElement, ns: string, name: string): boolean => element.ns === ns && element.name === name;

/**
 * `text` as XML character data or an attribute value: the markup characters escaped, and what XML
 * 1.0 cannot carry (control characters, lone surrogates), which a node's name may hold, replaced
 * by U+FFFD.
 */
export function xmlEscape(text: string): string {
  return text
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '�')
    .replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
}

/** A property as an answer names it: its namespace and local name. */
export type PropName = { ns: string; name: string };

/**
 * A property's element in an answer, empty or holding `inner` (markup already escaped): `D:` for
 * WebDAV's own, and a namespace declared on the element itself for any other.
 */
export function propElement(prop: PropName, inner = ''): string {
  if (prop.ns === DAV_NS) return inner === '' ? `<D:${prop.name}/>` : `<D:${prop.name}>${inner}</D:${prop.name}>`;
  const open = `${prop.name} xmlns="${xmlEscape(prop.ns)}"`;
  return inner === '' ? `<${open}/>` : `<${open}>${inner}</${prop.name}>`;
}

/** The status line of a propstat or response. */
const statusLine = (status: number, reason: string): string => `<D:status>HTTP/1.1 ${status} ${reason}</D:status>`;

/** A propstat: the properties given, each written out, under one status. */
export function propstat(props: string[], status: number, reason: string): string {
  return `<D:propstat><D:prop>${props.join('')}</D:prop>${statusLine(status, reason)}</D:propstat>`;
}

/** A multistatus answer's opening, before its responses. */
export const MULTISTATUS_OPEN = '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">';
export const MULTISTATUS_CLOSE = '</D:multistatus>\n';
