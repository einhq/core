import { Box, Card, Group, SimpleGrid, Skeleton, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconDatabase, IconDeviceFloppy } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { utilizationColor } from '../Pipeline/mod.ts';
import { SLICES } from '../Chart/plots.tsx';
import { formatBytes } from '../../lib/format.ts';
import type { DatabaseTable, StorageTier } from '@ein/api';

/** `tiers` is absent until the first answer arrives; the database's figures come with it, absent without a database. */
type Props = { tiers?: StorageTier[]; databaseBytes?: number; databaseTables?: DatabaseTable[] };

/** `other` is what the named slices leave: drawn in grey and named in plain text. */
type Slice = { key: string; label: string; value: number; color: string; other?: boolean };

const PIE = 112;
/** What the named tables leave of the database: the rest of Okabe–Ito's grey. */
const OTHER_COLOR = '#999999';
/** A tier's free space: a neutral that still shows against the card, which the bars' track does not. */
const FREE_COLOR = 'var(--mantine-color-default-border)';

/** A pie of the slices' shares of their sum, each slice naming itself on hover. */
function Pie({ slices }: { slices: Slice[] }) {
  const r = PIE / 2 - 1;
  const c = PIE / 2;
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  const at = (turn: number) => `${c + r * Math.sin(turn * 2 * Math.PI)},${c - r * Math.cos(turn * 2 * Math.PI)}`;

  let start = 0;
  return (
    <svg width={PIE} height={PIE} style={{ display: 'block', flexShrink: 0 }} role='img'>
      {total === 0 ? <circle cx={c} cy={c} r={r} fill={FREE_COLOR} /> : slices.map((slice) => {
        const turn = Math.max(0, slice.value) / total;
        const from = start;
        start += turn;
        if (turn === 0) return null;
        const common = { fill: slice.color, stroke: 'var(--mantine-color-body)' };
        const title = <title>{`${slice.label}: ${formatBytes(slice.value)}`}</title>;
        // A whole pie is a circle: an arc from a point back to itself draws nothing.
        if (turn > 0.9999) return <circle key={slice.key} cx={c} cy={c} r={r} {...common}>{title}</circle>;
        return (
          <path key={slice.key} d={`M${c},${c} L${at(from)} A${r},${r} 0 ${turn > 0.5 ? 1 : 0} 1 ${at(from + turn)} Z`} {...common}>
            {title}
          </path>
        );
      })}
    </svg>
  );
}

/** A card's heading: an icon, a title, and what it is of in small print. */
function Heading({ icon, title, detail }: { icon: ReactNode; title: string; detail?: ReactNode }) {
  return (
    <Group gap='xs' mb='md' wrap='nowrap'>
      {icon}
      <Title order={4} tt='capitalize' style={{ whiteSpace: 'nowrap' }}>{title}</Title>
      {detail}
    </Group>
  );
}

/**
 * One storage tier: used against free, and how long the free lasts.
 *
 * The projection is the reason this card exists: a crawl that writes derivatives faster than
 * anyone checks on it is how a 1.8 TB disk fills, and "3% used" is reassuring right up until the
 * day it isn't. `daysUntilFull` is absent rather than infinite when a tier is not growing — the
 * honest answer to "when does this fill" for a tier that isn't filling is "it doesn't".
 */
function TierCard({ tier, shared }: { tier: StorageTier; shared: boolean }) {
  const used = tier.totalBytes - tier.freeBytes;
  return (
    <Card>
      <Heading
        icon={<IconDeviceFloppy size={18} />}
        title={tier.tier}
        detail={<Text size='xs' c='dimmed' ff='monospace' truncate>{tier.path}</Text>}
      />
      <Group gap='lg' wrap='nowrap'>
        <Pie
          slices={[
            { key: 'used', label: 'Used', color: utilizationColor(tier.usedPercent), value: used },
            { key: 'free', label: 'Free', color: FREE_COLOR, value: tier.freeBytes },
          ]}
        />
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text size='xl' fw={700} style={{ whiteSpace: 'nowrap' }}>{formatBytes(tier.freeBytes)} free</Text>
          <Text size='sm' c='dimmed'>{Math.round(tier.usedPercent ?? 0)}% of {formatBytes(tier.totalBytes)} used</Text>
          {tier.bytesPerDay !== undefined && tier.bytesPerDay > 0 && <Text size='xs' c='dimmed'>+{formatBytes(tier.bytesPerDay)}/day</Text>}
          {tier.daysUntilFull !== undefined && (
            <Text size='xs' c={tier.daysUntilFull < 14 ? 'red' : 'dimmed'} fw={tier.daysUntilFull < 14 ? 600 : 400}>
              full in ~{tier.daysUntilFull} days
            </Text>
          )}
          {
            /* Tiers sharing a filesystem say so: their free space is one number reported several
              times, not several numbers that happen to match. */
          }
          {shared && (
            <Tooltip label={`Shares ${tier.device} with another tier — this free space is not additional`} withArrow>
              <Text size='xs' c='dimmed' truncate>shares {tier.device}</Text>
            </Tooltip>
          )}
        </Stack>
      </Group>
    </Card>
  );
}

/**
 * The database: its size, and which tables take it. Its disk's free space is not EiN's to read —
 * the database runs elsewhere, often on a disk of its own — so the pie is of what is in it, the
 * largest tables first and the rest as one slice.
 */
function DatabaseCard({ bytes, tables }: { bytes: number; tables: DatabaseTable[] }) {
  const named = tables.reduce((sum, table) => sum + table.bytes, 0);
  const slices: Slice[] = [
    ...tables.map((table, i) => ({ key: table.name, label: table.name, value: table.bytes, color: SLICES[i % SLICES.length] })),
    ...(bytes > named ? [{ key: '', label: 'other', value: bytes - named, color: OTHER_COLOR, other: true }] : []),
  ];

  return (
    <Card>
      <Heading icon={<IconDatabase size={18} />} title='Database' />
      <Group gap='lg' wrap='nowrap' align='flex-start'>
        <Pie slices={slices} />
        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Text size='xl' fw={700}>{formatBytes(bytes)}</Text>
          {slices.map((slice) => (
            <Group key={slice.key} gap={6} wrap='nowrap'>
              <Box w={8} h={8} style={{ flexShrink: 0, borderRadius: 2, background: slice.color }} />
              <Text size='xs' ff={slice.other ? undefined : 'monospace'} c={slice.other ? 'dimmed' : undefined} truncate title={slice.label} style={{ flex: 1 }}>
                {slice.label}
              </Text>
              <Text size='xs' c='dimmed' style={{ whiteSpace: 'nowrap' }}>{formatBytes(slice.value)}</Text>
            </Group>
          ))}
        </Stack>
      </Group>
    </Card>
  );
}

function CardSkeleton() {
  return (
    <Card>
      <Skeleton height={16} width='45%' mb='md' />
      <Group gap='lg' wrap='nowrap'>
        <Skeleton circle height={PIE} />
        <Stack gap={6} style={{ flex: 1 }}>
          <Skeleton height={22} width='70%' />
          <Skeleton height={12} width='55%' />
          <Skeleton height={10} width='35%' />
        </Stack>
      </Group>
    </Card>
  );
}

/** Each storage tier and the database, a card apiece with its pie. */
export function StorageUsage({ tiers, databaseBytes, databaseTables }: Props) {
  const grid = (children: ReactNode) => <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing='sm'>{children}</SimpleGrid>;
  if (!tiers) return grid([0, 1, 2].map((key) => <CardSkeleton key={key} />));

  const shared = new Set(tiers.filter((tier, _i, all) => all.filter((other) => other.device === tier.device).length > 1).map((tier) => tier.device));
  return grid(
    <>
      {tiers.length === 0 && (
        <Card>
          <Heading icon={<IconDeviceFloppy size={18} />} title='Storage' />
          <Text c='dimmed'>No tier data sampled yet</Text>
        </Card>
      )}
      {tiers.map((tier) => <TierCard key={tier.path} tier={tier} shared={shared.has(tier.device)} />)}
      {databaseBytes !== undefined && <DatabaseCard bytes={databaseBytes} tables={databaseTables ?? []} />}
    </>,
  );
}
