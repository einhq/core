import { signal } from '@preact/signals-react';
import type { ResolvedSection } from '@ui/nav';
import { pageLocation } from './module-ui.ts';
import { uiNav } from './nav.ts';

/** What a page says it shows (`usePageSubject`): its name, a line on what it shows, and the node it is about. */
export type PageSubject = { title?: string; about?: string; node?: string };

/** What the page shows, for code outside it: the sidebar entry it is under, and what it declares. */
export type PageShown = PageSubject & { section?: string };

type Declaration = { pathname: string; subject: PageSubject };

/** Every declaration in force; a signal, so the document's title follows them (`pageTitle`). */
const declarations = signal<Declaration[]>([]);

/**
 * Record what the route at `pathname` shows, until the returned function is called. Keyed by the
 * path, so a page still drawn while the next one loads is not taken for it. What is left out —
 * undefined, or empty words — says nothing, and does not hide what another declaration gave.
 */
export const declarePageSubject = (pathname: string, subject: PageSubject): () => void => {
  const named = Object.fromEntries(Object.entries(subject).filter(([, value]) => Boolean(value))) as PageSubject;
  const declaration = { pathname, subject: named };
  declarations.value = [...declarations.value, declaration];
  return () => void (declarations.value = declarations.value.filter((other) => other !== declaration));
};

/** The label of the sidebar entry a path is on or below, the most particular one; `/` only for itself. */
export const sectionLabel = (pathname: string, sections: ResolvedSection[]): string | undefined => {
  let best: { label: string; length: number } | undefined;
  for (const item of sections.flatMap((section) => section.items)) {
    const to = item.to.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
    const under = pathname === to || (to !== '/' && pathname.startsWith(`${to}/`));
    if (under && (!best || to.length > best.length)) best = { label: item.label, length: to.length };
  }
  return best?.label;
};

/** What the routes at `pathname` declare, a later declaration's fields over an earlier one's. */
export const subjectAt = (pathname: string, declared: Iterable<Declaration> = declarations.value): PageSubject => {
  const subject: PageSubject = {};
  for (const declaration of declared) {
    if (declaration.pathname === pathname) Object.assign(subject, declaration.subject);
  }
  return subject;
};

/** What the page — not a dialog or the drawer — shows now; undefined before it has a location. */
export const pageShown = (): PageShown | undefined => {
  const location = pageLocation();
  if (!location) return undefined;
  const section = sectionLabel(location.pathname, uiNav.value.sections);
  return { ...(section ? { section } : {}), ...subjectAt(location.pathname) };
};

/**
 * The document's title for the page at `pathname`: the name it declares, else its sidebar entry's
 * label, followed by the product's name. Home, and a page named by neither, is the product's name
 * alone.
 */
export const pageTitle = (pathname: string, sections: ResolvedSection[], declared: Iterable<Declaration> = declarations.value): string => {
  if (pathname === '/') return 'EiN';
  const name = subjectAt(pathname, declared).title ?? sectionLabel(pathname, sections);
  return name ? `${name} · EiN` : 'EiN';
};
