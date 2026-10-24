import { ActionIcon, Button, Group, Popover, Progress, RingProgress, ScrollArea, Stack, Text, Tooltip } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { IconLoader2, IconUpload } from '@tabler/icons-react';
import { countOf } from '../../lib/count-of.ts';
import { formatBytes } from '../../lib/format.ts';
import { type UploadCounts, uploadFiles } from '../../lib/upload-queue.ts';
import { cancelUploads, clearFinished, isUploading, retryFailed, uploadActive, uploadFailures, uploadSummary, uploadSummaryByTarget } from '../../signals/upload.ts';

/** How far `counts` are, 0–100, by bytes. */
const percentOf = (counts: UploadCounts): number => counts.bytesTotal > 0 ? Math.min(100, (counts.bytesDone / counts.bytesTotal) * 100) : 0;

/** "1,204 of 3,000", or "3,000 uploaded" once nothing waits. */
const progressText = (counts: UploadCounts): string => {
  const sent = counts.queued + counts.active + counts.done;
  return counts.queued + counts.active > 0 ? `${counts.done.toLocaleString()} of ${sent.toLocaleString()}` : `${countOf(counts.done, 'file', 'files')} uploaded`;
};

/**
 * The top bar's upload button: a ring of how far the uploads are while they run, and a panel of
 * them: the files in all, each target's progress (a staging category, an album), the files being
 * sent, the last failures, and Cancel, Retry and Clear. Nothing while no file was queued since the
 * last Clear.
 */
export function UploadIndicator() {
  useSignals();
  const summary = uploadSummary.value;
  const uploading = isUploading.value;
  if (uploadFiles(summary) === 0) return null;
  const targets = Object.entries(uploadSummaryByTarget.value);
  const active = uploadActive.value;
  const failures = uploadFailures.value;
  const percent = percentOf(summary);

  return (
    <Popover position='bottom-end' withArrow shadow='md'>
      <Popover.Target>
        <Tooltip label={uploading ? `Uploading ${progressText(summary)}` : 'Uploads'}>
          <ActionIcon variant='subtle' size='lg' style={{ position: 'relative' }} aria-label='Uploads'>
            {uploading
              ? (
                <>
                  <RingProgress size={32} thickness={3} sections={[{ value: percent, color: 'blue' }]} rootColor='transparent' />
                  <IconLoader2 size={16} style={{ position: 'absolute', animation: 'spin 1s linear infinite' }} />
                </>
              )
              : <IconUpload size={20} />}
          </ActionIcon>
        </Tooltip>
      </Popover.Target>

      <Popover.Dropdown>
        <Stack gap='sm' w={320}>
          <Stack gap={2}>
            <Text size='sm' fw={500}>{uploading ? `Uploading ${progressText(summary)}` : progressText(summary)}</Text>
            <Text size='xs' c='dimmed'>
              {formatBytes(summary.bytesDone)} of {formatBytes(summary.bytesTotal)}
              {summary.failed > 0 ? ` · ${summary.failed.toLocaleString()} failed` : ''}
              {summary.renamed > 0 ? ` · ${summary.renamed.toLocaleString()} saved under a new name, theirs was taken` : ''}
            </Text>
          </Stack>

          {targets.map(([root, counts]) => (
            <Stack key={root} gap={2}>
              <Group justify='space-between' gap='xs' wrap='nowrap'>
                <Text size='xs' fw={500} truncate title={root}>{counts.label}</Text>
                <Text size='xs' c='dimmed' style={{ flexShrink: 0 }}>
                  {progressText(counts)}
                  {counts.failed > 0 ? `, ${counts.failed.toLocaleString()} failed` : ''}
                </Text>
              </Group>
              <Progress value={percentOf(counts)} size='sm' color={counts.failed > 0 ? 'orange' : 'blue'} transitionDuration={200} />
            </Stack>
          ))}

          {active.length > 0 && (
            <Stack gap={4}>
              {active.map((item) => (
                <Group key={`${item.dir}/${item.name}`} gap='xs' wrap='nowrap'>
                  <IconLoader2 size={14} style={{ flexShrink: 0, animation: 'spin 1s linear infinite' }} />
                  <Text size='xs' truncate title={`${item.dir}/${item.name}`} style={{ flex: 1, minWidth: 0 }}>{item.name}</Text>
                  <Progress value={item.size > 0 ? (item.sent / item.size) * 100 : 0} size='xs' w={64} />
                </Group>
              ))}
            </Stack>
          )}

          {failures.length > 0 && (
            <ScrollArea.Autosize mah={160} type='auto'>
              <Stack gap={2}>
                {failures.map((failure, index) => (
                  <Text key={index} size='xs' c='red' title={`${failure.dir}/${failure.name}`}>
                    {failure.name}: {failure.error}
                  </Text>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}

          <Group justify='flex-end' gap='xs'>
            {uploading && <Button size='compact-xs' variant='default' onClick={cancelUploads}>Cancel</Button>}
            {summary.failed > 0 && <Button size='compact-xs' variant='light' onClick={retryFailed}>Retry failed</Button>}
            {!uploading && <Button size='compact-xs' variant='subtle' onClick={clearFinished}>Clear</Button>}
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
