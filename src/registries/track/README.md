# Track registry

Ordered series of geographic fixes — GPS tracks — stored one row per fix in
PostgreSQL with PostGIS, and answered by index rather than by scan.

| Implementation        | Backend              |
| --------------------- | -------------------- |
| `TrackRegistry`       | PostgreSQL + PostGIS |
| `MemoryTrackRegistry` | In-process arrays    |

## Why not a log

A log is indexed by entry id alone, so "what is in this box", "what happened
that week" and "what does this look like from far away" would all be full
scans, and since imports backdate `created_at`, entry id order is not time
order.

Here `(track_id, ts)` is the primary key. A backdated import, a re-uploaded
file and an out-of-order live feed all land correctly, and a duplicate fix is
ignored rather than appended twice.

## Schema

```
<name>_tracks         id, routing_keys, routing_patterns, points, first_ts, last_ts, north/south/east/west, rules
<name>_tracks_points  track_id, ts, geog GEOGRAPHY(POINT,4326), alt, speed, course, rule
                      PRIMARY KEY (track_id, ts)
                      GIST ((geog::geometry))
```

The summary lives on the track row and is folded forward on every append inside
the same transaction, because listing the tracks asks every track how big it is and
that must not touch the points table. It describes the accepted fixes, those no
rule rejected (see Rules). A delete recomputes it instead — a
deletion can move any bound, and deletes are rare. `summaries(ids)` answers a
listing in one query; the registry is the only place the summary is kept, so a
point appended from a routing key is in the next listing like any other.

The spatial index is on the **planar** `geog::geometry`, not on the geography:
a geography envelope cannot span 180+ degrees of longitude.

## Appends

A whole GPX file arrives in one `appendPoints` call, so the points travel as six
parallel arrays and postgres unnests them into rows — seven bind parameters
whatever the file weighs. A tuple list is the obvious shape and does not survive
the size: a bind message counts its parameters in 16 bits, so past ~10 900 fixes
the count wraps and postgres reports a mismatch against a number nobody asked
for (`bind message has 465 parameter formats but 0 parameters`). An import is
cheap enough this way to stay on the request path.

## Rules

A track keeps every fix it is given, and judges each against its neighbours as it
is stored (`rules.ts`). A leap is one step of over 1 km in at most 30 minutes; a jump
is a leap faster than 600 km/h, which nothing on the ground or the water does.

- `excursion`: a run the track leaps into and back out of, to near where it was,
  within two hours, with at least one of the leaps a jump; or a position the track
  leaps back onto to the last decimal after being away from it longer than it was
  there, which is how a phone falling back to a cell position looks. Rejected: left
  out of reads and of the summary.
- `jump`: any other jump with steady going on both sides, as when a logger starts
  again somewhere else. The fixes are kept and the line is cut before it.

A logger on an aircraft is fast at every step, so neither rule sees it.

The verdict is the point row's `rule`, NULL for accepted. An append judges the
fixes within reach of what it wrote (two and a half hours either way) in its own
transaction: a window function looks for a leap first, and only a window holding
one, or a fix already judged, is read and judged in TypeScript. A delete judges the
fixes around its ends. The track row's `rules` is the version of the rules it was
judged by; a track judged by an older one is judged again, a chunk at a time, before
its next read or write. Rejected fixes stay: `rejected` reads them too, marked, and
the byte-stream view always carries them.

## Reads

`readPoints(id, opts)` returns drawable segments, not raw rows:

- `bounds` filters through the GiST index. The box is widened by `margin`
  (default 25%) so lines reach the edge of the viewport instead of stopping
  short of it. Keeping exactly the points whose neighbour is inside would need
  a window function over the track's whole ordered sequence, which cannot use
  the index and so scans the whole track.
- `tolerance` simplifies. Postgres builds one `LINESTRINGM` per UTC day out of
  the matching fixes (M carries the fix time) and runs `ST_Simplify` on it, so
  what crosses the wire is already drawable. A simplified read carries position
  and time only — `alt`/`speed`/`course` are not vertices of a line.
- The result is then cut into segments on three boundaries: a day, because that
  is what carries a color, a pause, and a jump, because joining across either
  would draw a line the track never took. A jump starts a run, numbered in SQL,
  and each run is despiked, simplified and cut on its own. The pause threshold scales with the track's
  own sampling rhythm (see `segment.ts`).
- `still` hides what a device draws while it lies still. A spike is a fix
  reached and left faster than `maxSpeed` (default 50 kn); those go before
  simplifying, in SQL as a window over neighbouring fixes, since once thinned a
  spike's neighbours can be minutes away and the jump no longer looks fast.
  After simplifying, `collapseStill` (`segment.ts`) drops what spikes remain and
  finds stays: fixes held within `radius` metres (default 80) for `minMs`
  (default 15 min) at a median speed of `stillSpeed` m/s or less (default
  0.5 kn). Excursions that come back within 10 min without getting 300 m away
  are dropped, and each stay is drawn as two points on its centroid, at arrival
  and at departure. A fix without a recorded speed, which is every fix of a
  simplified read, is given one measured over five minutes either side of it.
- `limit` is the backstop, applied after simplification by striding each
  segment. `truncated` says whether anything was dropped that way.

`MemoryTrackRegistry` reimplements the bbox test, Douglas–Peucker and the
spike window in TypeScript, in the same planar degrees `ST_Simplify` uses, so
both implementations cut a line in the same locations. The conformance suite in
`test/track-conformance.ts` runs against both.

## Live feed

`routingKeys` binds a track to relay events, exactly as a log's do — wildcard
patterns included (`tracker.#`, see `src/registries/routing-key-match.ts`): publish a
point (or an array of them) on a bound key and it is appended. A handle read
with an `AbortSignal` blocks until points arrive — `tail -f` on a track — via
`LISTEN`/`NOTIFY` in postgres and an in-process waiter set in memory.

A handle opened for writing through the VFS also touches the track node, so
VFS subscribers (a page following the track, a pipeline rule) see an `updated`
event with no attr changed. `TrackHandle.onAppended` is called on the first
append that writes a row, then at most every five seconds while the handle stays
open, and on close for whatever is still unreported. Points appended from a
routing key go straight into the registry and do not touch the node.

## Byte-stream view

`TrackHandle.read()` yields points as JSONL in timestamp order, so `cat` works
on a track node; `write()` appends them. The typed methods (`appendPoints`,
`readPoints`, `deletePoints`, `summary`) are what the map uses.
