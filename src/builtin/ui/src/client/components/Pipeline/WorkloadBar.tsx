import { type BarSegment, StackedBar } from './StackedBar.tsx';
import { CANCELLED_COLOR, WAITING_COLOR, WORKLOAD_COLORS, WORKLOAD_LABELS, WORKLOAD_STATES, type WorkloadState } from './palette.ts';

export type Workload = Record<WorkloadState, number>;

type Props = {
  counts: Workload;
  /**
   * Work that has no instance yet — a matched trigger the engine has not started. Optional
   * because it is not an instance state and only the callers that know a pipeline's backlog
   * can supply it; where it is given, the bar stops being a breakdown of instances and becomes
   * a breakdown of all known work, which is what makes it readable as progress.
   */
  waiting?: number;
  /** Instances that were cancelled. Optional, like `waiting`: where it is given it is a segment of its own, never part of failed. */
  cancelled?: number;
  /** Bar thickness. The overview bar is chunky; per-pipeline rows are thin. */
  height?: number;
  /** Legend with counts underneath. Off for the compact per-pipeline rows. */
  legend?: boolean;
};

/**
 * The whole workload as one 100%-stacked bar: what has not started, what is
 * queued, running, broken, done and cancelled, in proportion — every piece of work that
 * is accounted for, in the order `PipelineMatrix` lists its columns.
 *
 * The drawing is `StackedBar`; what this adds is the workload vocabulary — the
 * fixed state order (load-bearing for colorblind separation, see palette.ts)
 * and the labels.
 */
export function WorkloadBar({ counts, waiting, cancelled, height = 14, legend = true }: Props) {
  const segments: BarSegment[] = WORKLOAD_STATES.map((state) => ({
    key: state,
    label: WORKLOAD_LABELS[state],
    color: WORKLOAD_COLORS[state],
    value: counts[state] || 0,
  }));

  // First, because Waiting is the leftmost column in `PipelineMatrix` and the bar is meant to
  // read in the same order as the numbers beside it. See the ordering note in palette.ts.
  if (waiting !== undefined) {
    segments.unshift({ key: 'waiting', label: 'Waiting', color: WAITING_COLOR, value: waiting });
  }

  // Last, after completed, as `PipelineMatrix` lists it.
  if (cancelled !== undefined) {
    segments.push({ key: 'cancelled', label: 'Cancelled', color: CANCELLED_COLOR, value: cancelled });
  }

  return <StackedBar segments={segments} height={height} legend={legend} emptyLabel='No work' />;
}
