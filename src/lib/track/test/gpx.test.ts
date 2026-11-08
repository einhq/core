/**
 * Core's GPX reader: the creator and names a file is matched to a device by, the file's own name,
 * description and time, and its fixes with their speed and course.
 */

import { assertEquals } from '@std/assert';
import { parseGpx } from '../gpx.ts';

Deno.test('parseGpx reads the creator and the names outside the points', () => {
  const gpx = parseGpx(`<gpx creator="Exempel Logger 2"><metadata><name>Morning walk</name></metadata>
    <trk><name><![CDATA[Day 1]]></name><trkseg><trkpt lat="1" lon="2"><name>Bench</name></trkpt></trkseg></trk></gpx>`);
  assertEquals(gpx.creator, 'Exempel Logger 2');
  assertEquals(gpx.names, ['Morning walk', 'Day 1']);
  assertEquals(gpx.points.length, 1);
});

Deno.test("parseGpx reads the file's own name, description and time, and its tracks' names", () => {
  const gpx = parseGpx(`<gpx creator="Exempel &amp; Co"><metadata><name>Morning walk</name><desc>Round the lake</desc><time>2001-01-01T09:00:00Z</time></metadata>
    <wpt lat="1" lon="2"><name>Bench</name><time>2001-01-01T09:30:00Z</time></wpt>
    <trk><name>Day 1</name><trkseg><trkpt lat="1" lon="2"><time>2001-01-01T10:00:00Z</time></trkpt></trkseg></trk>
    <trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk><trk><name>Day 2</name></trk></gpx>`);
  assertEquals(
    [gpx.creator, gpx.name, gpx.description, gpx.time, gpx.tracks],
    ['Exempel & Co', 'Morning walk', 'Round the lake', '2001-01-01T09:00:00Z', ['Day 1', 'Day 2']],
  );
  // GPX 1.0 has no <metadata>: the root's own children are the file's.
  const old = parseGpx('<gpx version="1.0"><name>Evening walk</name><trk><name>Leg</name></trk></gpx>');
  assertEquals([old.name, old.tracks], ['Evening walk', ['Leg']]);
});

Deno.test('parseGpx keeps speed and course, from GPX 1.0 or a TrackPointExtension', () => {
  const gpx = parseGpx(`<gpx><trk><trkseg>
    <trkpt lat="57.7" lon="11.9"><time>2001-01-01T10:00:00Z</time><extensions><gpxtpx:TrackPointExtension>
      <gpxtpx:speed>4.2</gpxtpx:speed><gpxtpx:course>271.5</gpxtpx:course></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="57.7" lon="11.9"><time>2001-01-01T10:00:01Z</time><speed>3</speed><course>90</course></trkpt>
    <trkpt lat="57.7" lon="11.9"><time>2001-01-01T10:00:02Z</time><speed>n/a</speed></trkpt>
  </trkseg></trk></gpx>`);
  assertEquals(gpx.points.map((point) => [point.speed, point.course]), [[4.2, 271.5], [3, 90], [undefined, undefined]]);
});
