import { useContext, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { declarePageSubject, type PageSubject } from '../signals/page-subject.ts';
import { SurfaceContext } from './useSurface.ts';

/**
 * Say what this page shows — its name, a line on what it shows, and the node it is about — for code outside it that asks
 * (`pageShown`): the chat in the drawer, asked about the page beside it. `EntityDetailHeader` says
 * it for the pages it heads. In a dialog, the drawer or full screen it says nothing: the page
 * under the surface is what is asked about.
 */
export function usePageSubject({ title, about, node }: PageSubject): void {
  const onPage = useContext(SurfaceContext) === null;
  const { pathname } = useLocation();
  useEffect(() => {
    if (!onPage || (!title && !about && !node)) return;
    return declarePageSubject(pathname, { ...(title ? { title } : {}), ...(about ? { about } : {}), ...(node ? { node } : {}) });
  }, [onPage, pathname, title, about, node]);
}
