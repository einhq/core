import { assertEquals, assertStringIncludes } from '@std/assert';
import { renderToStaticMarkup } from 'react-dom/server';
import { allDates, AxisPlot, PiePlot } from '../plots.tsx';
import { axis, labelEvery } from '../scale.ts';

type Points = { label: string; value: number }[];
const props = (points: Points) => ({ points, width: 480, active: undefined, onTip: () => {} });
const bars = (points: Points) => renderToStaticMarkup(<AxisPlot {...props(points)} bars dated={false} />);
const line = (points: Points) => renderToStaticMarkup(<AxisPlot {...props(points)} bars={false} dated={allDates(points.map((point) => point.label))} />);
const pie = (points: Points) => renderToStaticMarkup(<PiePlot {...props(points)} />);
const count = (html: string, tag: string) => html.split(`<${tag} `).length - 1;

Deno.test('axis', async (t) => {
  await t.step('a line fits its values on round ticks', () => {
    assertEquals(axis([71.3, 74.8]), { min: 71, max: 75, ticks: [71, 72, 73, 74, 75] });
  });
  await t.step('bars reach zero', () => {
    assertEquals(axis([3, 17], { zero: true }), { min: 0, max: 20, ticks: [0, 5, 10, 15, 20] });
  });
  await t.step('ticks of fractions do not drift', () => {
    assertEquals(axis([0.1, 0.7]).ticks, [0, 0.2, 0.4, 0.6, 0.8]);
  });
  await t.step('one value is drawn mid-axis', () => {
    const { min, max } = axis([5]);
    assertEquals(min < 5 && max > 5, true);
  });
});

Deno.test('labelEvery shows every label that fits, and fewer when they would overlap', () => {
  assertEquals(labelEvery(['a', 'b', 'c'], 400), 1);
  assertEquals(labelEvery(Array.from({ length: 30 }, (_, i) => `2026-${i}`), 400) > 1, true);
});

Deno.test('plots', async (t) => {
  await t.step('bars: one per point, its label below it', () => {
    const html = bars([{ label: 'Mon', value: 3 }, { label: 'Tue', value: 5 }, { label: 'Wed', value: 0 }]);
    assertEquals(count(html, 'rect'), 3);
    assertStringIncludes(html, '>Tue</text>');
  });
  await t.step('a dated line is spaced by time and labelled with dates', () => {
    const html = line([{ label: '2025-01-01', value: 80 }, { label: '2025-01-02', value: 79 }, { label: '2026-01-01', value: 75 }]);
    const xs = [...html.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));
    assertEquals(xs.length, 3);
    // The second point is a day after the first, the third a year: the gap shows.
    assertEquals(xs[1] - xs[0] < (xs[2] - xs[1]) / 100, true);
    assertStringIncludes(html, '>2025-01-01</text>');
    assertStringIncludes(html, '>2026-01-01</text>');
  });
  await t.step('a pie: a slice per share above zero', () => {
    assertEquals(count(pie([{ label: 'Cats', value: 2 }, { label: 'Dogs', value: 1 }, { label: 'None', value: 0 }]), 'path'), 2);
  });
  await t.step('a pie of one share is a whole circle', () => {
    const html = pie([{ label: 'All', value: 4 }]);
    assertEquals([count(html, 'path'), count(html, 'circle')], [0, 1]);
  });
  await t.step('an undated line is spaced evenly', () => {
    const xs = [...line([{ label: 'a', value: 1 }, { label: 'b', value: 2 }, { label: 'c', value: 4 }]).matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));
    assertEquals(xs[1] - xs[0], xs[2] - xs[1]);
  });
});
