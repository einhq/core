import { useEffect, useState } from 'react';
import { fileUrl } from '../lib/file-url.ts';
import { type Guide, GUIDE_ROOT, parseSummary } from '../lib/guide.ts';

/** The contents, read once per page load: the sidebar, the search and a module's page all ask for it. */
let loading: Promise<Guide | null> | undefined;

const loadGuide = async (): Promise<Guide | null> => {
  const res = await fetch(fileUrl(`${GUIDE_ROOT}/SUMMARY.md`));
  return res.ok ? parseSummary(await res.text()) : null;
};

export type UseGuideResult = {
  /** The guide's contents; null when this installation has no guide bundled. */
  guide: Guide | null;
  loading: boolean;
};

/** The bundled guide's contents, from its `SUMMARY.md`. */
export function useGuide(): UseGuideResult {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loading ??= loadGuide().catch(() => {
      loading = undefined;
      return null;
    });
    loading.then((result) => {
      if (cancelled) return;
      setGuide(result);
      setPending(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { guide, loading: pending };
}
