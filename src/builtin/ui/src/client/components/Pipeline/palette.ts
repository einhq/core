/**
 * Workload status colors.
 *
 * These are status hues, not a categorical series — each one means a state, so
 * they are never reused for anything else and always ship beside a label.
 *
 * ORDER. The stacking order is the order of the columns in `PipelineMatrix`, left to right:
 * waiting (prepended by `WorkloadBar`), queued, running, failed, completed, cancelled (appended by
 * `WorkloadBar`). A row's bar and its
 * numbers are then the same reading in two forms, and a color can be looked up by sliding along
 * the row rather than by remembering the legend. It also runs from not-started to done, which is
 * why the bar is legible without the legend at all.
 *
 * That puts red beside green, at a protan ΔE of 6.5 — below the floor for adjacent hues. What
 * makes it acceptable is that segments do not touch: `StackedBar` separates them by
 * SURFACE_GAP_PX of the card surface rather than by a border, so the comparison that matters is
 * each hue against the raised surface (#1d2027), not against its neighbour — completed 4.79,
 * queued 5.31, running 4.48, failed 5.05, waiting 4.37, all clear. Identity is carried by the
 * tooltip and the legend as well, never by color alone.
 *
 * If the gap is ever removed, this ordering has to go: adjacent red and green at ΔE 6.5 is
 * below the floor, and only an order with failed beside running and completed at the far end
 * satisfies it. Re-validate before reordering.
 */

export type WorkloadState = 'completed' | 'queued' | 'running' | 'failed';

/** Stacking order — the column order of `PipelineMatrix` between waiting and cancelled. See the note above before changing it. */
export const WORKLOAD_STATES: WorkloadState[] = ['queued', 'running', 'failed', 'completed'];

export const WORKLOAD_COLORS: Record<WorkloadState, string> = {
  completed: '#199e70',
  queued: '#c98500',
  running: '#3987e5',
  failed: '#e66767',
};

export const WORKLOAD_LABELS: Record<WorkloadState, string> = {
  completed: 'Completed',
  queued: 'Queued',
  running: 'Running',
  failed: 'Failed',
};

/**
 * Work that has not started — no instance yet, only a matched trigger.
 *
 * Outside `WorkloadState` deliberately: the states above are instance states, and this counts
 * things that are not instances. `WorkloadBar` still draws it as a segment where the caller
 * knows the backlog — a progress bar over instances alone hides the largest part of the work —
 * but it is appended after the four, so their validated order is untouched.
 *
 * Neutral rather than a fifth hue, because it is the absence of progress rather than a stage of
 * it. As a segment it is measured the same way as the others: 4.37 against the raised surface
 * #1d2027, in the band the four sit in (4.48-5.31), and it is never adjacent to a hue it could
 * be confused with.
 */
export const WAITING_COLOR = '#7d8590';

/**
 * Instances that were cancelled — stopped on purpose, so neither progress nor a fault.
 *
 * Outside `WorkloadState` for the same reason as waiting: it is not one of the stages the hues
 * mark, and a cancelled instance counted with the failed ones reads as a fault that `health` says
 * is not there. `WorkloadBar` appends it after completed, at the opposite end from waiting, so the
 * two neutrals never touch. Darker than waiting, so the legend tells them apart by lightness alone:
 * 3.22 against the raised surface #1d2027, above the 3:1 floor, and 1.36 against waiting.
 */
export const CANCELLED_COLOR = '#686f7a';

/** Single-series accent, for the completions sparkline. */
export const SERIES_ACCENT = WORKLOAD_COLORS.running;

/**
 * Utilization thresholds for the host and storage panels.
 *
 * No new hues: every resource chart on the dashboard is a *single* series on
 * its own tile, so a per-metric color would encode nothing — the label already
 * says which metric it is. What does carry meaning is how close a number is to
 * its ceiling, and that is a status, so it wears the status palette.
 *
 * These three are never adjacent fills in one mark (a tile is in exactly one
 * band at a time), which is why the amber↔red pair that the stacking order in
 * WORKLOAD_STATES had to avoid is not a problem here. They always ship with the
 * number and its label, never as color alone.
 */
export const UTILIZATION_BANDS = [
  { from: 90, color: WORKLOAD_COLORS.failed, label: 'critical' },
  { from: 75, color: WORKLOAD_COLORS.queued, label: 'high' },
  { from: 0, color: WORKLOAD_COLORS.completed, label: 'normal' },
] as const;

/** The band a percentage falls in. Undefined input reads as normal, not critical. */
export function utilizationColor(percent?: number): string {
  const band = UTILIZATION_BANDS.find((entry) => (percent ?? 0) >= entry.from);
  return band?.color ?? WORKLOAD_COLORS.completed;
}

/** The empty half of a usage bar — a surface, not a data color. */
export const TRACK_COLOR = 'var(--mrx-surface-raised)';

/** Gap between touching segments, in the surface color. */
export const SURFACE_GAP_PX = 2;

/**
 * Badge color for an instance or step status: the chart hue of the workload state it counts as,
 * so a badge and the charts agree. A step that is 'waiting' in a pool is queued work; 'cancelled'
 * wears the charts' cancelled neutral; a step that never started ('pending', 'skipped') is
 * neutral, like the charts' waiting segment.
 */
export function statusColor(status: string): string {
  switch (status) {
    case 'completed':
      return WORKLOAD_COLORS.completed;
    case 'running':
      return WORKLOAD_COLORS.running;
    case 'waiting':
    case 'queued':
      return WORKLOAD_COLORS.queued;
    case 'failed':
      return WORKLOAD_COLORS.failed;
    case 'cancelled':
      return CANCELLED_COLOR;
    default:
      return WAITING_COLOR;
  }
}
