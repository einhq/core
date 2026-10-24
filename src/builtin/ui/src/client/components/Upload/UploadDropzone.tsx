import { Box, getDefaultZIndex, Group, Portal, SimpleGrid, Stack, Text } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { useSignals } from '@preact/signals-react/runtime';
import { IconFolder, IconUpload } from '@tabler/icons-react';
import { type ComponentProps, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { usePhone } from '../../hooks/usePhone.ts';
import type { UploadTarget } from '../../lib/upload-queue.ts';
import { addToQueue, uploadBatchDone } from '../../signals/upload.ts';

/**
 * What a phone's picker offers: its photos, videos and recordings, and its camera among the
 * choices. Not on a desktop, where it would also turn away a raw file dropped on the window.
 */
const PHONE_ACCEPT = { 'image/*': [], 'video/*': [], 'audio/*': [], 'application/gpx+xml': ['.gpx'] };

/** An `<input>` that picks a folder, with everything in it, rather than files. */
const FOLDER_INPUT = { webkitdirectory: '' } as ComponentProps<'input'>;

type Common = {
  /** Keep the folders that were dropped or picked, under the target; otherwise every file goes straight into it. */
  keepFolders?: boolean;
  /** No target yet — the album is still loading, or the path could not be resolved. */
  disabled?: boolean;
  /** Called once the queue drains, if anything landed in a target (or a directory one answered). */
  onUploaded?: () => void;
};

/** Files into one directory: what a page's Upload action takes. */
export type UploadDropzoneProps = Common & {
  /**
   * Directory the files are written into, or what makes it when files are dropped and answers its
   * path: a directory that should not exist until something is uploaded into it.
   */
  path: UploadTarget;
  /** What the drop overlay and the upload list call it. Defaults to the directory's own name. */
  name?: string;
};

/** One of several places files can be dropped into: a tile of the drop overlay. */
export type UploadDropTarget = {
  path: UploadTarget;
  /** The tile's title, and what the upload list calls it. */
  label: string;
  /** A line under the title. */
  description?: string;
};

type Opener = RefObject<(() => void) | null>;

type SingleProps = UploadDropzoneProps & {
  targets?: undefined;
  /** Set to what opens the file picker. */
  openRef?: Opener;
  /** Set to what opens the folder picker. */
  openFolderRef?: Opener;
};

type TilesProps = Common & {
  /** Each a tile of the overlay, files dropped on it going into its `path`. */
  targets: UploadDropTarget[];
};

const withoutSlash = (dir: string): string => dir.length > 1 && dir.endsWith('/') ? dir.slice(0, -1) : dir;

/**
 * Calls `onUploaded` when a batch lands in one of `paths`, or in a directory one of them answered
 * when it was a function; answers each target wrapped to record that directory.
 *
 * A batch is announced to everyone; this one only cares about its own directories, and only about
 * batches that finish while it is up — the signal keeps its last value, so coming back to the page
 * must not replay it.
 */
function useLanded(paths: UploadTarget[], onUploaded: (() => void) | undefined) {
  const answered = useRef(new Set<string>());
  const batch = uploadBatchDone.value;
  const handled = useRef(batch?.at);
  const fixed = paths.filter((path): path is string => typeof path === 'string').map(withoutSlash);
  const fixedKey = fixed.join('\n');
  useEffect(() => {
    if (!batch || batch.at === handled.current) return;
    handled.current = batch.at;
    if (batch.dirs.some((dir) => fixed.includes(dir) || answered.current.has(dir))) onUploaded?.();
  }, [batch, fixedKey, onUploaded]);
  return useCallback((target: UploadTarget): UploadTarget =>
    typeof target === 'string' ? target : () =>
      target().then((dir) => {
        answered.current.add(withoutSlash(dir));
        return dir;
      }), []);
}

/**
 * Files dropped anywhere on the window, for as long as this page is the one being looked at.
 *
 * With `path`, they go into that directory, and the pickers are raised through `openRef` (files)
 * and `openFolderRef` (a folder and everything in it) — the page header's Upload. Full screen rather
 * than a region around the grid because the grid is the page — a bordered rectangle to aim at would
 * be the whole viewport anyway, and wrapping it costs the tiles their own drag and click handling.
 *
 * With `targets`, a drag of files raises a tile for each, and the files go where they are dropped.
 *
 * Every route queues the same way; the queue, its progress and cancelling are the header's
 * `UploadIndicator`, which is already global.
 */
export function UploadDropzone(props: SingleProps | TilesProps) {
  useSignals();
  const paths = props.targets ? props.targets.map((target) => target.path) : [props.path];
  const track = useLanded(paths, props.onUploaded);
  if (props.targets) return <DropTiles {...props} track={track} />;
  return <WindowDrop {...props} track={track} />;
}

function WindowDrop({ path, name, keepFolders, disabled, openRef, openFolderRef, track }: SingleProps & { track: (target: UploadTarget) => UploadTarget }) {
  const phone = usePhone();
  const label = name || (typeof path === 'string' ? path.split('/').filter(Boolean).pop() || path : undefined);
  const folderInput = useRef<HTMLInputElement>(null);
  const queue = (files: File[]) => {
    if (files.length > 0) addToQueue(files, track(path), { keepFolders, ...(label ? { label } : {}) });
  };

  useEffect(() => {
    if (!openFolderRef) return;
    openFolderRef.current = () => folderInput.current?.click();
    return () => {
      openFolderRef.current = null;
    };
  }, [openFolderRef]);

  return (
    <>
      {openFolderRef && (
        <input
          ref={folderInput}
          type='file'
          multiple
          hidden
          {...FOLDER_INPUT}
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = '';
            queue(files);
          }}
        />
      )}
      <Dropzone.FullScreen
        active={!disabled}
        openRef={openRef}
        accept={phone ? PHONE_ACCEPT : undefined}
        onDrop={queue}
        // The overlay is the whole window, so its message belongs in the middle of
        // it rather than tucked under the top edge, where Mantine leaves it.
        styles={{ inner: { height: '100%' } }}
      >
        <Group justify='center' align='center' gap='xl' style={{ height: '100%', minHeight: 220, pointerEvents: 'none' }}>
          <IconUpload size={52} stroke={1.5} />
          <Stack gap={4}>
            <Text size='xl'>Drop files to upload</Text>
            {label && (
              <Text size='sm' c='dimmed'>
                Into {label}
                {keepFolders ? ', folders and all' : ''}
              </Text>
            )}
          </Stack>
        </Group>
      </Dropzone.FullScreen>
    </>
  );
}

const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes('Files') ?? false;

/**
 * A drag of files over the window raises an overlay with a tile per target; files dropped on a
 * tile go into its target, and files dropped beside the tiles go nowhere (the browser does not
 * open them either). Only drags of files raise it, so a drag of tiles within the page does not.
 */
function DropTiles({ targets, keepFolders, disabled, track }: TilesProps & { track: (target: UploadTarget) => UploadTarget }) {
  // How many elements the drag is over: the overlay goes when it has left the last of them.
  const [depth, setDepth] = useState(0);

  useEffect(() => {
    if (disabled) return;
    const enter = (event: DragEvent) => {
      if (carriesFiles(event)) setDepth((value) => value + 1);
    };
    const leave = (event: DragEvent) => {
      if (carriesFiles(event)) setDepth((value) => Math.max(0, value - 1));
    };
    const over = (event: DragEvent) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setDepth(0);
    };
    document.addEventListener('dragenter', enter);
    document.addEventListener('dragleave', leave);
    document.addEventListener('dragover', over);
    document.addEventListener('drop', drop);
    return () => {
      document.removeEventListener('dragenter', enter);
      document.removeEventListener('dragleave', leave);
      document.removeEventListener('dragover', over);
      document.removeEventListener('drop', drop);
      setDepth(0);
    };
  }, [disabled]);

  if (depth === 0 || disabled) return null;
  return (
    <Portal>
      <Box
        p='xl'
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: getDefaultZIndex('max'),
          background: 'color-mix(in srgb, var(--mantine-color-body) 92%, transparent)',
          overflow: 'auto',
        }}
      >
        <Stack gap='lg' maw={960} mx='auto' mt='10vh'>
          <Stack gap={4} align='center'>
            <Text size='xl'>Drop the files on where they go</Text>
            {keepFolders && <Text size='sm' c='dimmed'>Folders keep their structure.</Text>}
          </Stack>
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing='md'>
            {targets.map((target) => (
              <Dropzone
                key={typeof target.path === 'string' ? target.path : target.label}
                activateOnClick={false}
                radius='md'
                p='xl'
                onDrop={(files) => {
                  setDepth(0);
                  if (files.length > 0) addToQueue(files, track(target.path), { keepFolders, label: target.label });
                }}
              >
                <Stack gap={4} align='center' style={{ pointerEvents: 'none' }}>
                  <Dropzone.Accept>
                    <IconUpload size={36} stroke={1.5} />
                  </Dropzone.Accept>
                  <Dropzone.Idle>
                    <IconFolder size={36} stroke={1.5} />
                  </Dropzone.Idle>
                  <Text fw={600} ta='center'>{target.label}</Text>
                  {target.description && <Text size='xs' c='dimmed' ta='center'>{target.description}</Text>}
                </Stack>
              </Dropzone>
            ))}
          </SimpleGrid>
        </Stack>
      </Box>
    </Portal>
  );
}
