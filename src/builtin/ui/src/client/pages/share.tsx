import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState/EmptyState.tsx';
import { PageLoader } from '../components/Layout/PageLoader.tsx';
import { countOf } from '../lib/count-of.ts';
import { panelRoute, panelsOf } from '../signals/nav.ts';
import { loadSharedFiles } from '../signals/shared-files.ts';
import { openDialog } from '../signals/surface.ts';

/**
 * `/share`, where the phone's Share menu lands once the service worker (the web manifest's
 * `share_target`) or the EiN app for Android took the files shared to EiN: it reads them into the
 * page and opens the first `share.receive` panel's route in the dialog over Home, which takes them
 * (`takeSharedFiles`).
 * Where the files go is a module's to offer; without one, the page says nothing takes them.
 */
export default function SharePage() {
  const navigate = useNavigate();
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    void loadSharedFiles().catch(() => 0).then((count) => {
      const receiver = panelsOf('share.receive')[0];
      if (count === 0 || !receiver) return setLeft(count);
      navigate('/', { replace: true });
      openDialog(panelRoute(receiver));
    });
  }, []);

  if (left === null) return <PageLoader />;
  if (left === 0) return <EmptyState title='Nothing was shared'>Share pictures to EiN from another app, such as the phone’s gallery, with its Share menu.</EmptyState>;
  return (
    <EmptyState title={`${countOf(left, 'file', 'files')} shared, with nowhere to go`}>
      Nothing on this EiN takes files shared from another app yet: that comes with a module.
    </EmptyState>
  );
}
