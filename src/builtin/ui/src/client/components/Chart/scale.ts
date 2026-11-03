/**
 * The arithmetic `Chart` draws by: round tick values for an axis, and which of many labels fit
 * under it. Import-free.
 */

/** The step between about `count` ticks over `span`: 1, 2 or 5 times a power of ten. */
const niceStep = (span: number, count: number): number => {
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
};

/**
 * An axis over `values`: its bounds on round numbers and the ticks between them, about `count`
 * of them. With `zero` the axis reaches 0, as bars stand on it; without, it fits the values, as
 * a line of a weight log should not be flattened against a zero far below it.
 */
export function axis(values: number[], { zero = false, count = 4 } = {}): { min: number; max: number; ticks: number[] } {
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (zero) {
    low = Math.min(0, low);
    high = Math.max(0, high);
  }
  if (low === high) {
    // One value, or all the same: a band around it, so it is drawn mid-height and not on an edge.
    const pad = low === 0 ? 1 : Math.abs(low) / 2;
    low = zero && low >= 0 ? 0 : low - pad;
    high = zero && high <= 0 ? 0 : high + pad;
  }
  const step = niceStep(high - low, count);
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  // Ticks from an integer count, not by adding the step, which drifts (0.1 + 0.2).
  for (let i = 0; min + i * step <= max + step / 2; i++) ticks.push(Number((min + i * step).toPrecision(12)));
  return { min, max, ticks };
}

/** Every how manyth of `labels` is shown under `width` pixels, so that none overlaps the next. */
export function labelEvery(labels: string[], width: number, charWidth = 6.5, gap = 12): number {
  if (labels.length === 0 || width <= 0) return 1;
  const widest = Math.max(...labels.map((label) => label.length)) * charWidth + gap;
  return Math.max(1, Math.ceil((widest * labels.length) / width));
}
