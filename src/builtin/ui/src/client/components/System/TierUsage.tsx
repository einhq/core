import { Box, Card, Group, Skeleton, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconDeviceFloppy } from '@tabler/icons-react';
import { StackedBar, TRACK_COLOR, utilizationColor } from '../Pipeline/mod.ts';
import { formatBytes } from '../../lib/format.ts';
import type { StorageTier } from '@ein/api';

/** `tiers` is absent until the first answer arrives. */
type Props = { tiers?: StorageTier[]; databaseBytes?: number };

/**
 * Free space per storage tier, and how long that lasts.
 *
 * The projection is the reason this panel exists: a crawl that writes
 * derivatives faster than anyone checks on it is how a 1.8 TB disk fills, and
 * "3% used" is reassuring right up until the day it isn't. `daysUntilFull` is
 * absent rather than infinite when a tier is not growing — the honest answer to
 * "when does this fill" for a tier that isn't filling is "it doesn't".
 *
 * Tiers sharing a filesystem are labelled as such, because their free space is
 * one number reported several times, not several numbers that happen to match.
 */
export function TierUsage({ tiers, databaseBytes }: Props) {
  const shared = new Set(
    (tiers ?? []).filter((tier, _i, all) => all.filter((other) => other.device === tier.device).length > 1).map((tier) => tier.device),
  );

  return (
    <Card>
      <Group gap='xs' mb='md'>
        <IconDeviceFloppy size={18} />
        <Title order={4}>Storage</Title>
        {databaseBytes !== undefined && <Text size='xs' c='dimmed' ml='auto'>database {formatBytes(databaseBytes)}</Text>}
      </Group>

      {!tiers
        ? (
          <Stack gap='md'>
            {[0, 1].map((key) => (
              <Box key={key}>
                <Skeleton height={12} width='45%' mb={6} />
                <Skeleton height={12} mb={6} />
                <Skeleton height={10} width='25%' />
              </Box>
            ))}
          </Stack>
        )
        : tiers.length === 0
        ? <Text c='dimmed'>No tier data sampled yet</Text>
        : (
          <Stack gap='md'>
            {tiers.map((tier) => {
              const used = tier.totalBytes - tier.freeBytes;
              return (
                <Box key={tier.path}>
                  <Group justify='space-between' mb={4} wrap='nowrap'>
                    <Group gap={6} wrap='nowrap'>
                      <Text size='sm' fw={600} tt='capitalize'>{tier.tier}</Text>
                      <Text size='xs' c='dimmed' ff='monospace' truncate>{tier.path}</Text>
                      {shared.has(tier.device) && (
                        <Tooltip label={`Shares ${tier.device} with another tier — this free space is not additional`} withArrow>
                          <Text size='xs' c='dimmed'>({tier.device})</Text>
                        </Tooltip>
                      )}
                    </Group>
                    <Text size='sm' c='dimmed' style={{ whiteSpace: 'nowrap' }}>
                      {formatBytes(tier.freeBytes)} free
                    </Text>
                  </Group>

                  <StackedBar
                    height={12}
                    legend={false}
                    segments={[
                      { key: 'used', label: 'Used', color: utilizationColor(tier.usedPercent), value: used },
                      { key: 'free', label: 'Free', color: TRACK_COLOR, value: tier.freeBytes },
                    ]}
                    describe={(segment) => `${segment.label}: ${formatBytes(segment.value)} of ${formatBytes(tier.totalBytes)}`}
                  />

                  <Group gap='xs' mt={4}>
                    <Text size='xs' c='dimmed'>{Math.round(tier.usedPercent ?? 0)}% used</Text>
                    {tier.bytesPerDay !== undefined && tier.bytesPerDay > 0 && <Text size='xs' c='dimmed'>· +{formatBytes(tier.bytesPerDay)}/day</Text>}
                    {tier.daysUntilFull !== undefined && (
                      <Text size='xs' c={tier.daysUntilFull < 14 ? 'red' : 'dimmed'} fw={tier.daysUntilFull < 14 ? 600 : 400}>
                        · full in ~{tier.daysUntilFull} days
                      </Text>
                    )}
                  </Group>
                </Box>
              );
            })}
          </Stack>
        )}
    </Card>
  );
}
