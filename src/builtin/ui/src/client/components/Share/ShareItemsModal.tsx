import { Alert, Button, Group, Radio, Stack, Text } from '@mantine/core';
import { IconAlertCircle, IconShare } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import type { ShareInfo, ShareSetResult } from '@ein/api';
import type { MediaSelection } from '../../hooks/useMediaSelection.ts';
import { useAccessIds } from '../../hooks/useAccessIds.ts';
import { useShare } from '../../hooks/useShare.ts';
import { countOf } from '../../lib/count-of.ts';
import { buildReferenceCommand, buildShareCommand, openingDraft, type ShareDraft } from '../../lib/share.ts';
import { shq } from '../../lib/shquote.ts';
import type { MediaItem } from '../../signals/album.ts';
import { notify } from '../../signals/notify.ts';
import { noteSharingChanged } from '../../signals/share.ts';
import { execCommand } from '../../signals/shell-client.ts';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { Dialog, DialogActions } from '../Surface/Dialog.tsx';
import { SelectionActionButton } from '../MediaGrid/SelectionActionButton.tsx';
import { PeopleEditor } from './PeopleEditor.tsx';
import { ShareSection } from './ShareModal.tsx';

/** What the selection is called: photos, videos, or items when it mixes kinds. */
const nounFor = (items: MediaItem[], count: number): string => {
  const kinds = new Set(items.map((item) => item.type));
  const [one, many] = kinds.size === 1 && kinds.has('photo') ? ['photo', 'photos'] : kinds.size === 1 && kinds.has('video') ? ['video', 'videos'] : ['item', 'items'];
  return countOf(count, one, many);
};

/** Only the owner: what "their own sharing" starts from for media that had none. */
const PRIVATE: ShareDraft = { mode: 0o700, grants: [] };

type Choice = 'album' | 'own';

type ShareItemsModalProps = {
  opened: boolean;
  onClose: () => void;
  /** The album the media is in, whose sharing they take or leave. */
  album: { path: string; title: string };
  items: MediaItem[];
  onSaved?: () => void;
};

/**
 * Chosen media inside an album, shared like the album or with sharing of their own: then they keep
 * it when the album's changes, and the album's link does not open them (`share-set --pin
 * --drop-links`). The album's own dialog lists what keeps its own sharing, to put back.
 */
function ShareItemsModal({ opened, onClose, album, items, onSaved }: ShareItemsModalProps) {
  const access = useAccessIds();
  // The album's sharing: whom the editor can add, and what "like the album" means.
  const { info, loading, error } = useShare(album.path, opened);
  const paths = items.map((item) => item.path);
  const noun = nounFor(items, items.length);

  const [choice, setChoice] = useState<Choice>('album');
  const [draft, setDraft] = useState<ShareDraft>(PRIVATE);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Opened on media that all keep their own sharing, the editor starts from the first one's.
  useEffect(() => {
    if (!opened || !info || paths.length === 0) return;
    if (!items.every((item) => item.pinned)) {
      setChoice('album');
      setDraft(PRIVATE);
      return;
    }
    setChoice('own');
    execCommand<ShareInfo>(`share-info ${shq(paths[0])}`)
      .then((first) => setDraft(openingDraft(first)))
      .catch(() => setDraft(PRIVATE));
  }, [opened, info, paths.join('\n')]);

  useEffect(() => {
    if (!opened) setFailure(null);
  }, [opened]);

  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const command = choice === 'album' ? buildReferenceCommand(paths, album.path) : buildShareCommand(paths, draft, { pin: true, dropLinks: true });
      const result = await execCommand<ShareSetResult>(command);
      noteSharingChanged(album.path);
      if (result.failed > 0) {
        setFailure(`${countOf(result.failed, 'item', 'items')} were left as they were: you cannot change them.`);
        return;
      }
      notify({ message: choice === 'album' ? `${noun} shared like the album` : `${noun} now ${one ? 'keeps its' : 'keep their'} own sharing` });
      onSaved?.();
      onClose();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const viaLink = (info?.links.length ?? 0) > 0;
  // One picture is "it", more are "they".
  const one = items.length === 1;

  return (
    <Dialog opened={opened} onClose={onClose} title={`Share ${noun}`} subtitle={`In “${album.title}”`} icon='share' pattern='media' size='lg'>
      {loading && !info && <PageLoader />}
      {error && (
        <Alert color='red' icon={<IconAlertCircle size={16} />}>
          {error.message}
        </Alert>
      )}
      {info && (
        <Stack gap='lg'>
          <Radio.Group value={choice} onChange={(value) => setChoice(value as Choice)}>
            <Stack gap='sm'>
              <Radio.Card value='album' p='md' radius='md'>
                <Group wrap='nowrap' align='flex-start'>
                  <Radio.Indicator />
                  <Stack gap={2}>
                    <Text size='sm' fw={500}>Like the album</Text>
                    <Text size='xs' c='dimmed'>
                      Whoever can see “{album.title}” can see {one ? 'it' : 'them'}
                      {viaLink ? ', and so can anyone with its link' : ''}. When the album's sharing changes, {one ? 'it changes' : 'they change'} with it.
                    </Text>
                  </Stack>
                </Group>
              </Radio.Card>
              <Radio.Card value='own' p='md' radius='md'>
                <Group wrap='nowrap' align='flex-start'>
                  <Radio.Indicator />
                  <Stack gap={2}>
                    <Text size='sm' fw={500}>{one ? 'Its' : 'Their'} own sharing</Text>
                    <Text size='xs' c='dimmed'>
                      Only those you choose below. {one ? 'It keeps' : 'They keep'} this when the album's sharing changes, and the album's link does not open{' '}
                      {one ? 'it' : 'them'}.
                    </Text>
                  </Stack>
                </Group>
              </Radio.Card>
            </Stack>
          </Radio.Group>

          {choice === 'own' && (
            <ShareSection title='People with access'>
              <PeopleEditor draft={draft} onChange={setDraft} info={info} count={items.length} editable showMembers={access?.admin === true} />
            </ShareSection>
          )}

          {failure && (
            <Alert color='yellow' icon={<IconAlertCircle size={16} />}>
              {failure}
            </Alert>
          )}
        </Stack>
      )}
      <DialogActions>
        <Button variant='default' onClick={onClose}>Cancel</Button>
        <Button loading={busy} disabled={!info} onClick={save}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * The selection bar's Share: chosen media in an album, shared like it or kept apart. Offered only for
 * media that lives in the album; a picture filed here by a link lives in another, whose sharing it
 * has.
 */
export function ShareSelectionAction({ selection, items, album }: { selection: MediaSelection; items: MediaItem[]; album: { path: string; title: string } }) {
  const [opened, setOpened] = useState(false);
  const selected = items.filter((item) => selection.selected.has(item.path));
  const inside = selected.length > 0 && selected.every((item) => !item.memberPath && item.path.startsWith(`${album.path}/`));

  return (
    <>
      <SelectionActionButton icon={<IconShare size={14} />} onClick={() => setOpened(true)} disabled={!inside}>
        Share
      </SelectionActionButton>
      <ShareItemsModal opened={opened} onClose={() => setOpened(false)} album={album} items={selected} onSaved={selection.clear} />
    </>
  );
}
