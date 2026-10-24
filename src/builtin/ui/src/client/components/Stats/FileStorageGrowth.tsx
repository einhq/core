import { IconDatabase } from '@tabler/icons-react';
import { formatBytes } from '../../lib/format.ts';
import type { NodeTypeGrowth } from '@ein/ui/hooks';
import { nodeTypeColor } from './NodeTypeGrowth.tsx';
import { STATS_COLORS } from './palette.ts';
import { YearBarChart } from './YearBarChart.tsx';

type Props = { files: NodeTypeGrowth };

export function FileStorageGrowth({ files }: Props) {
  return (
    <YearBarChart
      title='File storage growth'
      icon={<IconDatabase size={18} color={nodeTypeColor('file')} />}
      growth={files.years}
      value={(point) => point.bytes}
      format={formatBytes}
      color={nodeTypeColor('file')}
      total={formatBytes(files.totalBytes)}
      description='Logical file size added per calendar year, including originals, derivatives, and other file records'
      line={files.months.length > 0
        ? {
          points: files.months.map((point) => ({ month: point.month, value: point.totalBytes })),
          color: STATS_COLORS.sizeLine,
          label: 'Cumulative file size by month',
          format: formatBytes,
        }
        : undefined}
    />
  );
}
