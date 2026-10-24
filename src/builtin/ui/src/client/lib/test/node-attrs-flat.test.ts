import { assertEquals } from '@std/assert';
import { attrsWriteArgs, attrText, attrValue, changedTopLevel, flattenAttrs, parseAttrsJson, unflattenAttrs } from '../node-attrs-flat.ts';

const attrs = { name: 'Anna', contact: { email: 'a@b', phones: ['1', '2'] }, labels: ['x'], size: 3, empty: {}, none: null };

Deno.test('attrs flat: one row per leaf, dotted keys, empties kept as leaves', () => {
  assertEquals(flattenAttrs(attrs), [
    { key: 'name', value: 'Anna' },
    { key: 'contact.email', value: 'a@b' },
    { key: 'contact.phones.0', value: '1' },
    { key: 'contact.phones.1', value: '2' },
    { key: 'labels.0', value: 'x' },
    { key: 'size', value: 3 },
    { key: 'empty', value: {} },
    { key: 'none', value: null },
  ]);
});

Deno.test('attrs flat: round-trips, and an edit lands inside its object', () => {
  assertEquals(unflattenAttrs(flattenAttrs(attrs), attrs), attrs);
  const rows = flattenAttrs(attrs).map((row) => row.key === 'contact.email' ? { ...row, value: 'c@d' } : row);
  const after = unflattenAttrs(rows, attrs);
  assertEquals(after.contact, { email: 'c@d', phones: ['1', '2'] });
  assertEquals(changedTopLevel(attrs, after), { set: ['contact'], unset: [] });
});

Deno.test('attrs flat: removing a list row compacts the list; removing a key unsets it', () => {
  const rows = flattenAttrs(attrs).filter((row) => row.key !== 'contact.phones.0' && row.key !== 'size');
  const after = unflattenAttrs(rows, attrs);
  assertEquals((after.contact as { phones: string[] }).phones, ['2']);
  assertEquals(changedTopLevel(attrs, after), { set: ['contact'], unset: ['size'] });
});

Deno.test('attrs flat: a new dotted key makes a nested object, a numeric tail makes a list', () => {
  const after = unflattenAttrs([{ key: 'a.b', value: 1 }, { key: 'l.0', value: 'x' }], {});
  assertEquals(after, { a: { b: 1 }, l: ['x'] });
});

Deno.test('attrs flat: text conversion keeps a string a string and parses the rest', () => {
  assertEquals(attrText('a'), 'a');
  assertEquals(attrText(3), '3');
  assertEquals(attrText(true), 'true');
  assertEquals(attrValue('42', 'was string'), '42');
  assertEquals(attrValue('42', 1), 42);
  assertEquals(attrValue('not json', 1), 'not json');
});

Deno.test('attrs json: an object parses; anything else says why', () => {
  assertEquals(parseAttrsJson('{ "name": "a sailboat", "year": 1987 }'), { ok: true, value: { name: 'a sailboat', year: 1987 } });
  assertEquals(parseAttrsJson('[1]').ok, false);
  assertEquals(parseAttrsJson('null').ok, false);
  assertEquals(parseAttrsJson('{ "name": }').ok, false);
  assertEquals(parseAttrsJson('{ "": 1 }'), { ok: false, message: 'An attribute needs a name.' });
  assertEquals(parseAttrsJson('{ "a=b": 1 }').ok, false);
});

Deno.test('attrs json: only changed top-level keys are written, removed ones deleted', () => {
  const quote = (text: string) => `'${text}'`;
  const before = { name: 'Anna Andersson', location: { lat: 1 }, gone: true };
  const after = { name: 'Anna Andersson', location: { lat: 2 }, added: [1] };
  assertEquals(attrsWriteArgs(before, after, quote), [`-J 'location={"lat":2}'`, `-J 'added=[1]'`, `-d 'gone'`]);
  assertEquals(attrsWriteArgs(before, before, quote), []);
});
