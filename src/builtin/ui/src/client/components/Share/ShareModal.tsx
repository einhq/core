import { Alert, Badge, Button, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconAlertCircle, IconCheck } from '@tabler/icons-react';
import { type ReactNode, useEffect, useState } from 'react';
import type { ShareInfo, ShareSetResult } from '@ein/api';
import { useAccessIds } from '../../hooks/useAccessIds.ts';
import { useShare, useShareHolder } from '../../hooks/useShare.ts';
import { countOf } from '../../lib/count-of.ts';
import { buildShareCommand, defaultDraft, draftVisibility, openingDraft, privateDraft, type ShareDraft } from '../../lib/share.ts';
import { noteSharingChanged } from '../../signals/share.ts';
import type { HatPattern } from '../EntityDetail/HatField.tsx';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { Dialog, DialogActions } from '../Surface/Dialog.tsx';
import { ExceptionsSection } from './ExceptionsSection.tsx';
import { LinkSection } from './LinkSection.tsx';
import { PeopleEditor } from './PeopleEditor.tsx';
import { VISIBILITY, VisibilityBadge } from './SharingChip.tsx';

/** What a node is called in a sentence, by its type. */
const NOUNS: Record<string, string> = {
  album: 'album',
  directory: 'folder',
  person: 'person',
  location: 'place',
  device: 'device',
  track: 'track',
  file: 'file',
};

const nounOf = (type: string): string => NOUNS[type] ?? 'item';

/** The pattern of a type's pages, which its sharing dialog is headed in. */
const PATTERNS: Record<string, HatPattern> = {
  album: 'album',
  directory: 'system',
  person: 'person',
  location: 'location',
  device: 'device',
  track: 'track',
  file: 'media',
};

/** The types whose page reads nothing outside the node, so a link can open one on its own. */
const LINKABLE = new Set(['album']);

/** A titled part of the dialog. */
export function ShareSection({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <Stack gap='xs'>
      <Group gap='xs' justify='space-between' wrap='nowrap'>
        <Text size='md' fw={600}>{title}</Text>
        {aside}
      </Group>
      {children}
    </Stack>
  );
}

/** What the Default preset does to the node: whom the configured default shares it with, and who then owns it. */
const defaultExplain = (info: ShareInfo): string => {
  const { uid, gid, ownerName, groupName } = info.default;
  const group = info.groups.find((each) => each.gid === gid);
  const shared = `Shared as new things are, with ${group?.title ?? group?.groupname ?? groupName ?? `group ${gid}`}`;
  if (uid === info.owner.uid) return shared;
  const owner = info.users.find((user) => user.uid === uid);
  return `${shared}, and owned by ${owner?.title ?? owner?.username ?? ownerName ?? `user ${uid}`}`;
};

/** What a save did, in a sentence or two; failures make it a warning. */
const saveReport = (result: ShareSetResult): { text: string; warn: boolean } => {
  const parts = ['Saved.'];
  if (result.pinned > 0) {
    parts.push(result.pinned === 1 ? '1 item inside keeps its own sharing.' : `${countOf(result.pinned, 'item', 'items')} inside keep their own sharing.`);
  }
  if (result.failed > 0) parts.push(`${countOf(result.failed, 'item', 'items')} inside were left as they were: you cannot change them.`);
  return { text: parts.join(' '), warn: result.failed > 0 };
};

type ShareModalProps = {
  /** The node being shared. */
  path: string;
  opened: boolean;
  onClose: () => void;
};

/**
 * Who may see a node, and who may change it: an album, a person, a device, a track or a location,
 * because the question is the same for all of them and the answer is stored the same way — mode
 * bits plus an access list on the node, which a save gives everything below it.
 */
export function ShareModal({ path, opened, onClose }: ShareModalProps) {
  const [shown, setShown] = useState<{ title: string; type: string } | null>(null);
  return (
    <Dialog
      opened={opened}
      onClose={onClose}
      title={shown ? `Share “${shown.title}”` : 'Share'}
      icon='share'
      pattern={(shown && PATTERNS[shown.type]) ?? 'mixed'}
      size='lg'
    >
      <SharePanel path={path} enabled={opened} onClose={onClose} onInfo={setShown} />
    </Dialog>
  );
}

type SharePanelProps = {
  path: string;
  /** Fetch and show; `false` while the panel is parked somewhere hidden. */
  enabled: boolean;
  /** Given, a Cancel/Close button is shown that calls it; absent, the host owns closing. */
  onClose?: () => void;
  /** Told what the node is called and what type it is, for a host that names it in its title. */
  onInfo?: (info: { title: string; type: string }) => void;
};

/**
 * The sharing dialog's body, so another dialog — the node properties — can carry it as a tab, and
 * the nodes explorer's tool pane can show it; its buttons are the dialog's bar, or a row there.
 *
 * People are changed in a draft and saved together, in one walk over everything below the node; a link is made,
 * changed and deleted at once, since one copied before a save would open nothing. Its visibility —
 * public, restricted, private — is what the rows and links add up to, shown as they change; two
 * presets set the rows to the configured default sharing, or to the owner alone.
 */
export function SharePanel({ path, enabled, onClose, onInfo }: SharePanelProps) {
  const share = useShare(path, enabled);
  const { info, revision, loading, error } = share;
  const access = useAccessIds();

  const [draft, setDraft] = useState<ShareDraft | null>(null);
  // Any write, which holds the controls still; `saving` is the Save button's own, which a link
  // made or deleted does not set.
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<{ text: string; warn: boolean } | null>(null);
  // A node that keeps its own sharing can be given back to what holds it: then the draft shows the
  // holder's sharing, and a save takes it from there and lets the holder's changes reach it again.
  const holder = useShareHolder(path, enabled && info?.pinned === true);
  const [follow, setFollow] = useState(false);

  // A fresh read replaces the draft: the dialog opens on what is actually stored, and a save
  // re-reads so the rows show what the server settled on. Reading only the links again does not.
  useEffect(() => {
    if (info) setDraft(openingDraft(info));
    setFollow(false);
  }, [revision]);

  useEffect(() => {
    if (info) onInfo?.({ title: info.title, type: info.type });
  }, [info?.title, info?.type]);

  useEffect(() => {
    if (!enabled) setReport(null);
  }, [enabled]);

  if (loading && !info) return <PageLoader />;

  if (error) {
    return (
      <Alert color='red' icon={<IconAlertCircle size={16} />}>
        {error.message}
      </Alert>
    );
  }

  if (!info || !draft) return null;

  const editable = info.canEdit;
  const noun = nounOf(info.type);
  const ownerName = info.owner.title ?? info.owner.username ?? `user ${info.owner.uid}`;
  // The owner a save leaves it with: the configured one, when the draft gives it that.
  const defaultOwner = draft.defaultOwner && info.default.uid !== info.owner.uid ? info.users.find((user) => user.uid === info.default.uid) : undefined;
  const changed = follow || buildShareCommand(path, draft) !== buildShareCommand(path, openingDraft(info));
  const visibility = draftVisibility(draft, info.links.length > 0, info.guestBrowsing);
  const holderNoun = holder && nounOf(holder.type);
  const presets = [
    { label: 'Default', explain: defaultExplain(info), draft: defaultDraft(info) },
    { label: 'Private', explain: 'Only the owner can see it', draft: privateDraft(draft) },
    ...(holder ? [{ label: `Like the ${holderNoun}`, explain: `Shared as “${holder.title}” is, and changed with it`, draft: openingDraft(holder), follow: true }] : []),
  ];
  const chosen = (preset: { draft: ShareDraft; follow?: boolean }) =>
    preset.follow ? follow : !follow && buildShareCommand(path, preset.draft) === buildShareCommand(path, draft);
  const edit = (next: ShareDraft) => {
    setDraft(next);
    setFollow(false);
  };

  /** Run a write, report what it did or why it failed. */
  const write = async (action: () => Promise<{ text: string; warn: boolean } | null>) => {
    setBusy(true);
    setReport(null);
    try {
      setReport(await action());
    } catch (err) {
      setReport({ text: err instanceof Error ? err.message : String(err), warn: true });
    } finally {
      setBusy(false);
      // Even a failed write may have changed part of it.
      noteSharingChanged(path);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await write(async () => saveReport(follow && holder ? await share.shareLike(holder.path) : await share.save(draft)));
    } finally {
      setSaving(false);
    }
  };

  const createLink = () =>
    write(async () => {
      const created = await share.createLink();
      return created.failed > 0 ? { text: `The link does not open ${countOf(created.failed, 'item', 'items')} inside that you may not change.`, warn: true } : null;
    });

  return (
    <>
      <Stack gap='lg'>
        {!editable && <Text size='sm' c='dimmed'>Only {ownerName} and people who can edit it can change who it is shared with.</Text>}

        <ShareSection title='Who can see it' aside={<VisibilityBadge visibility={visibility} />}>
          <Text size='sm' c='dimmed'>{visibility ? VISIBILITY[visibility].explain : 'Everyone with an account can see it'}.</Text>
          {info.pinned && holder && !follow && <Text size='sm' c='dimmed'>It keeps its own sharing: changes to the {holderNoun} “{holder.title}” do not reach it.</Text>}
          {editable && (
            <Group gap='xs'>
              {presets.map((preset) => (
                <Tooltip key={preset.label} label={preset.explain} withArrow>
                  <Button
                    variant={chosen(preset) ? 'light' : 'default'}
                    size='compact-sm'
                    onClick={() => {
                      setDraft(preset.draft);
                      setFollow(preset.follow === true);
                    }}
                    disabled={busy}
                  >
                    {preset.label}
                  </Button>
                </Tooltip>
              ))}
            </Group>
          )}
        </ShareSection>

        <ShareSection title='People with access'>
          <PeopleEditor
            draft={draft}
            onChange={edit}
            info={info}
            owner={defaultOwner
              ? {
                uid: defaultOwner.uid,
                name: defaultOwner.title ?? defaultOwner.username,
                username: defaultOwner.username,
                path: defaultOwner.path,
                personPath: defaultOwner.personPath,
                you: access?.uid === defaultOwner.uid,
              }
              : {
                uid: info.owner.uid,
                name: ownerName,
                username: info.owner.username,
                path: info.owner.path,
                personPath: info.owner.personPath,
                you: access?.uid === info.owner.uid,
              }}
            editable={editable}
            showMembers={access?.admin === true}
          />
        </ShareSection>

        {(LINKABLE.has(info.type) || info.links.length > 0) && (
          <ShareSection title='Share with a link'>
            <LinkSection
              links={info.links}
              editable={editable}
              noun={noun}
              exceptions={info.exceptionCount}
              onCreate={createLink}
              onExpiry={(id, expiry) => write(async () => (await share.setLinkExpiry(id, expiry), null))}
              onRemove={(id) => write(async () => (await share.removeLink(id), null))}
            />
          </ShareSection>
        )}

        {info.exceptionCount > 0 && (
          <ShareSection
            title={
              <Group gap={6} wrap='nowrap'>
                <span>With their own sharing</span>
                <Badge size='sm' variant='light' color='gray'>{info.exceptionCount}</Badge>
              </Group>
            }
          >
            <ExceptionsSection
              exceptions={info.exceptions}
              count={info.exceptionCount}
              noun={noun}
              editable={editable}
              onFollow={(paths) => write(async () => (await share.shareLikeThis(paths), null))}
              onFollowAll={() => write(async () => (await share.shareAllLikeThis(), null))}
            />
          </ShareSection>
        )}

        {report && (
          <Alert color={report.warn ? 'yellow' : 'green'} icon={report.warn ? <IconAlertCircle size={16} /> : <IconCheck size={16} />}>
            {report.text}
          </Alert>
        )}
      </Stack>

      <DialogActions>
        {onClose && <Button variant='default' onClick={onClose}>{editable && changed ? 'Cancel' : 'Close'}</Button>}
        {editable && <Button loading={saving} disabled={!changed || (busy && !saving)} onClick={save}>Save</Button>}
      </DialogActions>
    </>
  );
}
