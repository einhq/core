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
<name>_tracks         id, routing_keys, routing_patterns, points, first_ts, last_ts, north/south/east/west
<name>_tracks_points  track_id, ts, geog GEOGRAPHY(POINT,4326), alt, speed, course
                      PRIMARY KEY (track_id, ts)
                      GIST ((geog::geometry))
```

The summary lives on the track row and is folded forward on every append inside
the same transaction, because listing the tracks asks every track how big it is and
that must not touch the points table. A delete recomputes it instead — a
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
- The result is then cut into segments on two boundaries: a day, because that
  is what carries a color, and a pause, because joining across a hole would
  draw a line the track never took. The pause threshold scales with the track's
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
