import { IconChartHistogram } from '@tabler/icons-react';
import type { NodeTypeGrowth as NodeTypeGrowthData } from '@ein/ui/hooks';
import { type EntityKind, kindGlyph } from '../../lib/entity-kind.ts';
import { STATS_COLORS } from './palette.ts';
import { YearBarChart } from './YearBarChart.tsx';

type Props = { nodeType: NodeTypeGrowthData };

const LABELS: Record<string, string> = {
  exif: 'EXIF',
  gps: 'GPS',
  ocr: 'OCR',
  vfs: 'VFS',
};

const labelFor = (type: string) => LABELS[type] ?? `${type.charAt(0).toUpperCase()}${type.slice(1)}`;

const CARD_KIND_BY_NODE_TYPE: Partial<Record<string, EntityKind>> = {
  album: 'album',
  person: 'person',
  location: 'location',
  device: 'device',
  track: 'track',
  file: 'document',
};

/** Match entity cards where a node type has a card vocabulary; internal types use card gray. */
export const nodeTypeColor = (type: string): string => kindGlyph(CARD_KIND_BY_NODE_TYPE[type] ?? 'other');

export function NodeTypeGrowth({ nodeType }: Props) {
  const label = labelFor(nodeType.type);
  const color = nodeTypeColor(nodeType.type);

  return (
    <YearBarChart
      title={`${label} nodes`}
      icon={<IconChartHistogram size={18} color={color} />}
      growth={nodeType.years}
      value={(point) => point.count}
      format={(value) => value.toLocaleString()}
      color={color}
      total={`${nodeType.total.toLocaleString()} nodes`}
      description={`${label} nodes created per calendar year`}
      line={{
        points: nodeType.months.map((point) => ({ month: point.month, value: point.total })),
        color: STATS_COLORS.nodeLine,
        label: 'Cumulative total by month',
        format: (value) => value.toLocaleString(),
      }}
    />
  );
}
