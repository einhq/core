/** The XML WebDAV requests are read from, and its answers written in. */

import { assertEquals, assertThrows } from '@std/assert';
import { parseXml, propElement, XmlError, xmlEscape } from '../dav/xml.ts';
import { propRequest } from '../dav/propfind.ts';

Deno.test('a propfind reads with prefixed and default namespaces alike', () => {
  const prefixed = parseXml('<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><x:colour xmlns:x="urn:example:x"/></d:prop></d:propfind>');
  assertEquals(propRequest(prefixed), { kind: 'prop', props: [{ ns: 'DAV:', name: 'getetag' }, { ns: 'urn:example:x', name: 'colour' }] });
  assertEquals(propRequest(parseXml('<propfind xmlns="DAV:"><allprop/></propfind>')), { kind: 'allprop' });
  assertEquals(propRequest(parseXml('<propfind xmlns="DAV:">\n  <!-- names only -->\n  <propname/>\n</propfind>')), { kind: 'propname' });
  assertEquals(propRequest(undefined), { kind: 'allprop' });
});

Deno.test('a namespace holds for the element that declares it and below, and an inner one shadows it', () => {
  const root = parseXml('<a:r xmlns:a="urn:one" xmlns="urn:default"><a:x xmlns:a="urn:two"><b/></a:x><y/></a:r>');
  assertEquals([root.ns, root.children[0].ns, root.children[0].children[0].ns, root.children[1].ns], ['urn:one', 'urn:two', 'urn:default', 'urn:default']);
});

Deno.test('text keeps its references, character references and CDATA', () => {
  const root = parseXml('<t>a &amp; b &lt;c&gt; &#229;&#xE4;<![CDATA[<raw & text>]]>&apos;&quot;</t>');
  assertEquals(root.text, 'a & b <c> åä<raw & text>\'"');
});

Deno.test('a document type, an entity and anything else that is not plain XML is refused', () => {
  for (
    const text of [
      '<!DOCTYPE d [<!ENTITY a "aaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><d>&b;</d>',
      '<d>&unknown;</d>',
      '<d>a & b</d>',
      '<p:d/>',
      '<a><b></a></b>',
      '<a>',
      '<a/><b/>',
      '<a/>trailing',
      '<?xml version="1.0" encoding="ISO-8859-1"?><a/>',
      '<a x=1/>',
      '',
    ]
  ) assertThrows(() => parseXml(text), XmlError, undefined, text);
});

Deno.test('the reader stops at a depth and a number of elements no request comes near', () => {
  assertThrows(() => parseXml('<a>'.repeat(65) + '</a>'.repeat(65)), XmlError, 'levels');
  assertThrows(() => parseXml(`<a>${'<b/>'.repeat(10_000)}</a>`), XmlError, 'elements');
  // A long malformed tag is read once, not backtracked over.
  const started = performance.now();
  assertThrows(() => parseXml(`<a${' '.repeat(200_000)}`), XmlError);
  assertEquals(performance.now() - started < 1000, true);
});

Deno.test('many namespace declarations cost no more than few, and a tag takes a bounded number of attributes', () => {
  const declarations = Array.from({ length: 60 }, (_, i) => ` xmlns:p${i}="urn:example:${i}"`).join('');
  const body = `<a xmlns="DAV:">${`<b${declarations}><c/></b>`.repeat(3000)}</a>`;
  const started = performance.now();
  const root = parseXml(body);
  assertEquals(root.children.length, 3000);
  assertEquals(root.children[0].children[0].ns, 'DAV:');
  assertEquals(performance.now() - started < 1000, true);

  const tooMany = Array.from({ length: 65 }, (_, i) => ` a${i}="x"`).join('');
  assertThrows(() => parseXml(`<a${tooMany}/>`), XmlError, 'attributes');
  assertThrows(() => parseXml(`<${'n'.repeat(300)}/>`), XmlError, 'malformed name');
  assertThrows(() => parseXml(`<a xmlns="${'u'.repeat(1100)}"/>`), XmlError, 'namespace');
});

Deno.test('a propfind names at most a hundred properties', () => {
  const props = (n: number) => `<propfind xmlns="DAV:"><prop>${'<getetag/>'.repeat(n)}</prop></propfind>`;
  assertEquals(propRequest(parseXml(props(100))).kind, 'prop');
  assertThrows(() => propRequest(parseXml(props(101))), XmlError, 'properties');
});

Deno.test('what goes out is escaped, and what XML cannot carry is replaced', () => {
  assertEquals(xmlEscape(`a<b>&"c"'d'`), 'a&lt;b&gt;&amp;&quot;c&quot;&apos;d&apos;');
  assertEquals(xmlEscape('tab\there\u0001bell\uD800'), 'tab\there�bell�');
  assertEquals(propElement({ ns: 'DAV:', name: 'getetag' }, '"x"'), '<D:getetag>"x"</D:getetag>');
  assertEquals(propElement({ ns: 'urn:example:x', name: 'colour' }), '<colour xmlns="urn:example:x"/>');
});
