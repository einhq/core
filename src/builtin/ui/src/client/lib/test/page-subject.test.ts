import { assertEquals } from '@std/assert';
import type { ResolvedSection } from '@ui/nav';
import { declarePageSubject, pageTitle, sectionLabel, subjectAt } from '../../signals/page-subject.ts';

const link = (label: string, to: string) => ({ id: label, section: 'main', label, icon: 'x', to });
const sections: ResolvedSection[] = [
  { id: 'main', items: [link('Home', '/'), link('People', '/people'), link('System', '/system'), link('Pipelines', '/system/pipelines')] },
  { id: 'more', items: [link('Settings', '/settings?tab=account')] },
];

Deno.test('a path is under the most particular sidebar entry, and `/` only under its own', () => {
  assertEquals(sectionLabel('/', sections), 'Home');
  assertEquals(sectionLabel('/people/Anna_Exempel', sections), 'People');
  assertEquals(sectionLabel('/system/pipelines/media', sections), 'Pipelines');
  assertEquals(sectionLabel('/settings', sections), 'Settings');
  assertEquals(sectionLabel('/peoplex', sections), undefined);
  assertEquals(sectionLabel('/map', sections), undefined);
});

Deno.test("a page's subject is what its path declares, later fields over earlier, until withdrawn", () => {
  const header = declarePageSubject('/people/Anna_Exempel', { title: 'Anna Exempel', node: '/archive/people/Anna_Exempel' });
  const other = declarePageSubject('/albums/A', { title: 'Sommar' });
  const retitled = declarePageSubject('/people/Anna_Exempel', { title: 'Anna' });
  assertEquals(subjectAt('/people/Anna_Exempel'), { title: 'Anna', node: '/archive/people/Anna_Exempel' });
  retitled();
  assertEquals(subjectAt('/people/Anna_Exempel'), { title: 'Anna Exempel', node: '/archive/people/Anna_Exempel' });
  header();
  other();
  assertEquals(subjectAt('/people/Anna_Exempel'), {});
});

Deno.test('a page declares no name it does not have, so it is named by nothing rather than empty', () => {
  const unnamed = declarePageSubject('/staging', { title: '', about: '' });
  assertEquals(subjectAt('/staging'), {});
  unnamed();
});

Deno.test("the document's title is the page's name, else its sidebar entry's, and Home's is the product's", () => {
  const person = { pathname: '/people/Anna_Exempel', subject: { title: 'Anna Exempel' } };
  const home = { pathname: '/', subject: { title: 'Welcome' } };
  assertEquals(pageTitle('/people/Anna_Exempel', sections, [person, home]), 'Anna Exempel · EiN');
  assertEquals(pageTitle('/people', sections, [person, home]), 'People · EiN');
  assertEquals(pageTitle('/', sections, [person, home]), 'EiN');
  assertEquals(pageTitle('/map', sections, []), 'EiN');
});
