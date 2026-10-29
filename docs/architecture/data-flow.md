# Data Flow Examples

Part of [EiN Architecture](../architecture.md), which holds the core: topology, VFS, registries, managers, commands, node types, boot and servers.

## Album listing

```
UI: useAlbumMedia("/albums/2024")
  → execCommand("ls -l /albums/2024")
    → ExecManager → ls command
      → VFS.children("/albums/2024")
        → PgStore.getChildren(id)
      → returns JSON array of NodeChildEntry
  → hook transforms to MediaItem[]
```

## Domain events

Between "a node changed" and "work should run" sits a layer of **domain facts**:
`media.metadata.extracted`, `media.face.detected`, `media.faces.completed`. A VFS event reports a mutation; a
fact reports something true about the world. Pipelines trigger on facts, because a
fact is a projection of VFS state — re-derivable after a gap, and independent of
whoever produced it.

Publishing is writing JSONL to a router node; there is no dedicated command or API.
`/dev/events` carries domain facts on the `system.events` routing key, and
`/dev/pipeline-events` carries engine lifecycle on `system.pipeline`:
`pipeline.instance.started` / `.completed` / `.failed`, and `pipeline.step.started` /
`.completed` / `.failed` / `.skipped`. Each has the run's node as `subject` and
`{pipeline, instance}` in `data`, plus `step` and `attempts` for a step (`exitCode` and
`cause` when it failed) and `failedSteps` for a failed instance. The engine emits them
from its in-process watch of the instance and step nodes, so a step a pool worker or
`pipeline restart` moves is reported the same as one the engine runs, and in the order
the transitions happened. Lifecycle sits on its own key deliberately: a run starting or
finishing is observability, not a fact, and the engine does not consume it — with one
pipeline per capability it would multiply the trigger queue's volume for no one's
benefit.

```sh
echo '{"id":"…","type":"media.file.discovered","subject":"/albums/x/a.jpg","time":…,"data":{"mimetype":"image/jpeg"}}' > /dev/events
```

The envelope is `{id, type, subject, nodeId?, time, source?, data?, write?}` (`lib/events`).
`subject` is the node the fact is about and becomes the pipeline's `$NODE_PATH`;
`data` holds whatever a trigger needs to decide, flattened into the filter's
environment as `$EVENT_<UPPER_SNAKE>` — so matching costs no round-trip back to the
node. That is what makes many small pipelines affordable. `write` is the audited
write the fact was derived from (`{auditId, uid}`), which the run it starts records
as the `cause` of every write it makes.

**Who emits.** One bridge service, and nothing else. `archive-bridge`
(`modules/archive/bin/archive-bridge`) owns a durable queue bound to the VFS routing keys its
rules care about, and writes the resulting facts. It runs two rule sets,
`modules/archive/lib/media/event-rules.ts` and `modules/archive/lib/location/event-rules.ts`,
joined in `modules/archive/lib/event-rules.ts`, which hands each message only to the rule sets
that bind its routing key — the media rules never see `position.updated`, for one. Steps stay dumb — they write to the VFS and the fact follows from
what they wrote, so the event stream cannot disagree with what is on disk. It also
centralises the derived-node guard (`sourceId`) that every media pipeline would
otherwise repeat in its own `skipIf`. `media-scan` replays the same rules over an
existing subtree, so backfill and the live path share one definition of "needs
indexing".

Before walking, `media-scan` counts running ingest instances and ready jobs at
`${POOLS_PATH}/triggers` (default `/var/pools/triggers`). A full backlog emits no
facts and does not change the stored cursor, even with `--restart`. This is a
manual reconciliation guard, not a change to the live bridge or its queue.

Media command metadata reads go directly through the caller's VFS access instead
of spawning `info`/`attrs` subshells. A fingerprint job asks EMS (`fingerprint.compute`),
which hashes a picture or a video's keyframes and takes a recording's chromaprint.

The location rules (`modules/archive/lib/location/event-rules.ts`) bind `location.created`,
`location.updated`, `position.created`, `position.updated` and `softlink.created`. A location is a `location` node; its
shape is its `position` child, as a photo's GPS point is `<file>/position`. They announce
`location.changed` — a location created, its shape written, an attr its position derives from
changed (`address`, `displayName`, `name`, `locationSource`), or a photo linked to it by hand — and
`location.point.changed` when a photo's GPS point is written. `position.updated` with **no changed
attrs** is a shape write: a writable handle on a `position` node touches the node when it closes
(`ContentWriteHandle`), the counterpart of a file handle's size report, since the shape is registry
content no attr describes. Without it a point being written would be invisible, and a rule acting
on `created` runs before the point exists — writers `ensure` the node first and write it after. A `<file>/location` link that `location-link-media` made
from a shape (`linkSource: 'shape'`) announces nothing and never counts toward a centroid;
otherwise a circle would pull in the photos inside it and let them redraw it, smaller each round.
A deleted link cannot be followed to its location and is not announced.

`media-scan` adds one rule the bridge has no use for: `deriveGaps`, which re-emits
`media.metadata.extracted` for a file that has EXIF but is missing something derived
from it — a fingerprint, derivatives, (video/audio) a description, (images only) the `facesAt`
marker `detect-faces` writes in both of its exit paths, or (video and audio) the
transcoded renditions. One re-emit re-opens the whole fan-out and every pipeline's own
`skipIf` drops the stages already done, so the predicate has to carry a term per
pipeline: a stage it does not ask about is a stage nothing ever re-announces, and a
guard like `skipIfAttr: facesAt` then keeps it unstarted for good. A source carrying
`undecodable` is excluded — no re-announcement will ever close that gap, so it would
republish on every scan.

`deriveGaps` also finds a transcript that is _done but superseded_, or that an interrupted run
left without its `transcribedAt`, and announces it as `media.transcript.stale`, which
`media-transcribe` runs with `-f`. A transcript's `transcribedWith` is compared with the transcribe
signature the media service reports for this pass, so both sides come from the side that decodes
and the check always terminates. It covers audio and video, compares only transcripts that name a
model (a file with no audio track carries nulls and would otherwise re-announce forever), and is
simply off for a pass in which the media service cannot be asked.
`CFG_MEDIA_TRANSCRIPTS_CURRENT=off` turns it off for good.

Image work downstream of detection is deliberately different: `detect-faces` writes `facesAt` only
after every face node and crop has been processed, including a zero-face result, and that file
update derives `media.faces.completed`. What needs the final face geometry starts from this fact,
so it is independently visible and retryable without holding the detection job open. Transcription of video and audio starts from `metadata.extracted`,
and `media.transcript.generated` (the transcript gaining `transcribedAt`) starts their voices. A
video's `media.faces.completed` is derived only on the write that sets `facesAt`; on a video whose
voices came first it ties them to the faces (`media-speaker-faces`), and a face of such a video
changing person is `media.speakers.face-changed`, which decides its voices again.

The transcode term needs its own read because `media-transcode` writes under
`thumbnails/` next to the poster frames: a video with still frames and no transcode has
a `thumbnails/` directory and the derivatives term reads it as complete. It counts
children by extension (`.mp4`, `.m4a`) rather than by name, since the names are the
target boxes from `config/sizes.yaml`, and it expects one rendition rather than two for
a video too short to get a hover clip.

It also counts renditions EMS **refused**. `video.transcode` declines a rendition when a CPU
decode of the source will not fit in EMS's budget (`EMS_CPU_ENCODE_MAX_MB`) and cannot be
split into placeable windows; it answers `refused`, permanent, and `generate-derivatives`
records that on the file node as **`transcodeRefused`** — a map keyed by the rendition's
file name, so one source can be refused its 1080p rendition and still owe its hover clip.
Without it the gap rule announced the same file on every scan forever, the same shape
`undecodable` already had and for the same reason: `deriveGaps` reads the file node, and
a step node is not one (`pipeline-retention-by-age` removes those).

The refusal is a function of EMS's encode budget, not of the source, so each entry stores
the signature it was decided under — `capabilities.encode.cpu_budget`, EMS's own
`<max MB>/<MB per 1k frames>/<max windows>`, read through `transcodeBudget()` in `@ems/client`
by the writer and again by every scan, so the two cannot derive it differently — and it is
compared against EMS's current one. Raising any of the three knobs on EMS makes every
refusal recorded under the old signature stale, which re-opens those gaps without anyone
clearing an attr; a rendition that is subsequently made clears its own entry. A context
with no signature — EMS not answering — trusts no refusal, which can only cause a
re-announcement.

A pass over the corpus is **resumable**, and has to be: the facts are predicates, so a run
that starts at the top every time re-announces whatever the previous run announced and the
engine has not drained yet — the 8.1x redundancy that a 15-minute timer produced. Each run
examines at most `--scan-limit` files (default 20000) and stores where it stopped as
`mediaScanCursor` on the root it was given, so repeated runs cover the library instead of
repeating its first slice; reaching the end of the subtree ends the pass and clears the
cursor. Resuming finds the entry the cursor names rather than comparing names against it,
since a listing is ordered by `(position, name)` in PostgreSQL and by insertion order in
memory. `--restart` goes back to the top.

The per-file cost of a pass is the other half. The walk asks for child edges
(`ChildrenOptions.childLinks`), so one batched lookup per directory answers "does this file
have `thumbnails/`, a `position`, a `metadata/` at all" for every file in it, and the exif
node is read once per file rather than once per rule. Measured over ten files in the fast
tier: 52 VFS reads before, 22 after when they are fully indexed, and 20 before against 0
after when they are not indexed at all.

`media-device` is the one pipeline hanging off that fact with no gap term, deliberately:
`device-link` writes nothing when the registry holds no match, so from the file side a
link that never ran and one that ran and matched nothing are the same thing, and a term
would republish every file from an unregistered camera on every scan. It is swept from
the registry side instead, where the thing that changed actually lives —
`device-relink <device>`, or `device-relink --all` over the whole registry, each device
an indexed equality over the exif nodes carrying its fingerprint.

A video's storyboard sheet and its chapters have no gap term either: they are steps of
`media-transcode`, made whenever that pipeline runs for the video, and a missing one is only a
timeline without frames or chapters, not a reason to republish every video indexed before it.

The bridge consumes its queue with `ARCHIVE_BRIDGE_CONCURRENCY` (default 4) competing
consumers, the same shape as the engine below. Ordering is not a constraint on it:
the rules read the node fresh rather than trusting the event payload, so a fact is a
projection of current state whichever order it is derived in, and two consumers
racing on one subject converge in the engine's trigger pool, which dedups on
`<pipeline>/<nodeId>`.

## Pipeline trigger

A pipeline declares either form of trigger, never both:

```yaml
trigger:
  on: media.metadata.extracted # a domain fact (preferred)
  filter: |
    case "$EVENT_MIMETYPE" in image/*) exit 0;; *) exit 1;; esac
```

```yaml
trigger:
  event: updated # a raw VFS mutation
  nodeType: file
```

Either form drops a subject that is a derived file unless the definition opts in with
`allowDerived: true` — see **Derived outputs** below.

The PipelineEngine consumes a durable queue `/var/queues/pipeline-engine` for triggers —
they persist until acked, so an upload while the engine is down is not lost. It binds
`system.events` plus exactly the VFS keys its loaded `event:`-form definitions ask for
(`system.vfs.<nodeType>.<eventType>`), recomputed whenever definitions change. A system
with only fact-triggered pipelines therefore receives no raw VFS events at all. It enumerates
those keys rather than binding `system.vfs.#` on purpose — the same reason the archive bridge lists
its own.

The engine's **own** state — instance nodes, step nodes, definitions —
is watched in-process via `vfs.subscribe`, not through the queue. Every step
transition is a node update, and persisting each one only to read it back was the
largest single contributor to a 453,437-message backlog during a crawl. Durability
buys nothing there: `recover()` re-advances every running instance at startup, which
is what a replayed event would have done. Those handlers schedule their work onto a
macrotask — once mandatory to escape the emitting mutation, now kept for coalescing:
a burst of step updates on one instance collapses into a single advance.

The queue is consumed by `PIPELINE_CONSUME_CONCURRENCY` (default 4) competing
consumers, one handle each — a queue handle allows a single unacked entry, so
concurrency is N handles on the one subscription, not a faster loop. They share the
registry's single LISTEN connection and hold no pooled client across the wait, so
idle consumers cost nothing — `PgQueueRegistry.read` releases its client after the
first claim attempt rather than keeping it for the whole blocking wait, which is
what makes adding consumers free rather than a trade against the pool. Messages are
therefore processed out of order; nothing depends on their order, and two consumers
racing on one subject converge because the pool job below is keyed on the subject.

**Queue leases.** A consumer holds an entry for at most `leaseMs` (default 60s); past
that the next consumer to find nothing claimable sweeps it back to ready. Handle close
nacks the in-flight entry, but close is best-effort — a killed process never runs it —
so without a lease every restart could strand whatever its consumers held, permanently:
`read` claims only unlocked rows and nothing else ever reset one. In production that had
accumulated 74 stranded deliveries on the engine's queue and 18 on the bridge's over two
weeks, in bursts of 1–5 per restart. `stat()` therefore reports claimable and in-flight
as separate numbers rather than one `COUNT(*)`: an entry a consumer is holding is not
backlog, and adding the two is what made the depth read the same whether the engine was
wedged or draining. Redelivery is safe because both consumers are written for
at-least-once — the bridge's duplicate facts are absorbed by `skipIf`, and a re-dispatched
trigger is an upsert onto a pool job keyed by subject.

**Dead-lettering bounds redelivery.** Each delivery carries an `attempts` count, spent by
the claim itself rather than by the nack, and a `dead_at` that takes it out of the
claimable set once it has used up `maxAttempts` (default 10). Without that a message that
can never succeed — a node that no longer resolves, a payload the rules cannot parse — was
claimable again the moment it was nacked, so the next poll tick handed it back to a
consumer that failed on it again: one entry occupying a consumer roughly once a second and
logging an error each time, forever. Counting the claim rather than the nack is what also
bounds the crash-loop variant, where the consumer dies holding the entry and never nacks at
all — the lease sweep spends the attempt instead. The threshold is higher than the pool's
`maxAttempts: 3` because a queue redelivers immediately: with no backoff between attempts
the count is the only tolerance a transient failure gets, and three attempts would be three
seconds. `maxAttempts: 0` restores retry-forever. A dead entry stays as a row and `stat()`
reports it as a third number beside claimable and in-flight, so the poison message is still
there to look at; `pipeline-overview` prints `dead N` on the queue line only when there are
any, and `health` fails until a person has seen them. `queue-dead <queue>` lists them, and with
`--retry` puts them back in line with no attempts spent or with `--drop` deletes them (`--id`
for one); opening the queue in `w` mode empties it whole.

**A matched trigger becomes a pool job, not an instance.** The consume loop matches
and then `poolAdd`s to `/var/pools/triggers` keyed `<pipeline>/<nodeId>`; a claim loop
inside the engine turns those into instances, `PIPELINE_TRIGGER_CONCURRENCY`
(default 4) at a time. Two things follow. **Re-announcing a subject is free**, not
merely rare: `dedupKey` is unique among a pool's non-terminal jobs, so ten
announcements of one subject are one row and one instance — the measured backlog in
production held 152,855 distinct (fact, subject) pairs across 1.12M messages, 7.4x redundant,
and a queue cannot collapse that however cheap each message is. And the **unstarted**
backlog now lives in the layer that can order it, instead of in the one that cannot:
creating an instance is a handful of node writes, and doing that inline made
_announcing_ work as expensive as _scheduling_ it.

`CFG_PIPELINE_ENTRY_ADMISSION_PERCENT` optionally reserves a percentage of these claims for
definitions declaring `options.entryPoint`. It uses fractional credit rather than a burst, so
60 produces three reserved probes in each five-claim window while entry work exists. A reserved
probe that finds no entry work immediately falls back to the ordinary rotation; the remaining
claims still use the existing fair rotation. The default is zero and preserves prior scheduling
exactly. This is admission preference only — the weighted media pool below still decides which
CPU work can execute.

**Admission rotates across pipelines.** A trigger job's priority is its lane's alone — 0 for
the normal lane, the bulk offset below it for a bulk fact (see Lanes in
[architecture.md](../architecture.md#lanes)) — and the pool orders `eff_priority DESC, created_at
ASC`. Within a lane an unfiltered claim is therefore strict global FIFO, which starves one class of
pipeline systematically rather than randomly: a pipeline triggered by a _domain event_
(`media-face-assign` on `media.face.detected`, `media-voiceprint` on
`media.transcript.generated`) can only be announced once an upstream step has already run
on that file, so its job is always younger than the upstream jobs of every file queued
since. Behind a backlog it is permanently last — measured in production, the oldest 200 ready
jobs were 3.5 days old and contained no face-assign at all, while a
face-assign step takes 3.3s. The visible symptom is a half-processed library: faces
detected but unassigned, so people do not appear in the UI.

So the claim counts how many open instances each pipeline already holds and probes the
least-loaded pipeline first. The round-robin cursor breaks ties between equal loads, so
neither definition order nor a pipeline's runtime can monopolise admission. A sole backlog
can still borrow the whole ceiling; when another pipeline becomes ready, its lower occupancy
puts it first for each freed slot until the budget is balanced. `claim()` returns its
`tryClaim` result directly when given no `AbortSignal`, and that is what makes the probes
non-blocking; with a signal they would
park on the first empty kind forever. The rotation carries one unfiltered slot so a job
whose pipeline no longer exists is still reached under load. The wildcard is assigned the
highest current pipeline load, so every less-loaded definition is probed directly before it
can return work from an incumbent. A fully empty rotation falls through to a blocking
unfiltered claim, preserving "null means abort, never _nothing_".

This is fairness, not capacity: a starved kind goes from ~0 to its share of admission. Per-kind
throughput is still bounded by `PIPELINE_MAX_ADMITTED_STEPS` and the workers below.

The claim loop stays inside the engine rather than moving to a `pipeline-worker`:
`advanceDAG` serialises on an in-process mutex and dispatches steps on the engine's
own shell, so whoever creates an instance must be the one that advances it. What the
pool contributes here is dedup, durability and a lease — not distribution. A job is
re-read against the _current_ definitions at claim time, so one that sat across a
reload builds from the steps that exist now; one whose pipeline is gone is completed
as skipped rather than retried forever. `pipeline start` / `pipeline rerun` still
create instances directly (`createInstanceFromDef`), bypassing the pool.

**An instance is `running` only while something is executing.** The two live states are
`running` and `queued`, and they differ on whether any step is on a core this instant:
`running` means a step was dispatched inline or a pool worker has claimed it and moved it to
`running`; `queued` means the instance is unfinished but every remaining step is either
`waiting` in a pool nobody has claimed it from or `pending` on a dependency. Guards test
`isLiveInstance`, never one of the two values — a guard spelled `=== 'running'` silently stops
covering queued instances, which for recovery or cancellation orphans their pool jobs.
An instance is created, restarted and repaired `queued`; the engine's advance moves it to
`running` when a step starts executing.

They were one value until 2026-09-06, and collapsing them was misleading rather than merely
imprecise: the media pool runs one job at a time against ~100 ready, so ~100 instances read
`running` while exactly one was. A dashboard showing `media-describe 16 running 0 done` looked
like sixteen wedged jobs when it was one job and fifteen queue entries, and diagnosing the
captioner on 2026-09-05 lost real time to that reading. `pipeline-overview`'s `active` list —
the dashboard's "what is executing" panel — is the same fix: it queries `status = running`, so
it now means what its heading says.

**Admission is bounded separately from execution.** `CFG_PIPELINE_MAX_CONCURRENT` limits
how many steps _run_; `PIPELINE_MAX_ADMITTED_STEPS` (default `maxConcurrent × 25`)
limits how many are _dispatched_ — running plus parked on the semaphore. The two are
different because `dispatchStep` marks a step `running`, tracks its promise, and only
then parks: every ready step of every running instance is a live promise holding its
command and paths. Nothing bounded that except how slowly triggers arrived, and once
the trigger pool began feeding instances at 5.5/s, production reached 24,349 dispatched steps
across 25,748 running instances and V8 killed the process on a 2 GB heap.

The gate has **two limits, counting two different costs**. Only inline steps reach
`dispatchStep`; a `pool:` step is marked `waiting` and handed to `/var/pools/*`, so a
pipeline whose steps are all delegated (media-faces, media-speaker-faces, media-transcribe,
media-transcode, media-face-assign) would otherwise be admitted without being counted at
all. So `inFlight` is bounded by `CFG_PIPELINE_MAX_ADMITTED_STEPS`, and the per-instance
advance lock — one entry per instance the engine holds open, dropped when an advance
sees it terminal — is bounded by `CFG_PIPELINE_MAX_OPEN_INSTANCES` (default 5000).

They were one number, `max(inFlight.size, advanceLocks.size)`, until 2026-09-06, and
that charged both at the same rate when they differ by orders of magnitude. A dispatched
step is a parked promise holding its command, env and paths; an open instance is a Map
entry and a Mutex, with its work sitting in Postgres. The 2 GB heap above was 24,349 of
the first kind — the 25,748 open instances alongside them were a few MB. Charging the
cheap one at the expensive one's rate meant `maxConcurrent × 25` = 100 slots in production
were all held by queued `media-describe` instances waiting on a one-at-a-time GPU
worker, while `media-ingest` sat at 98,847 waiting and zero running.

What bounds the instance side is `kickOpenInstances`, which re-advances every open
instance and is therefore O(open) reads per sweep — not heap. The sweep runs only while
the gate is saturated and at most every `ADMISSION_KICK_MS`.

The trigger claim order makes the ceiling fair by occupancy, not merely by claim count.
Open instance locks and trigger creations already in progress are counted per pipeline;
the least-loaded ready pipeline gets the next slot, while round-robin ordering breaks equal
loads. This matters because trigger priority and plain round-robin order only choose claims:
a slow pipeline otherwise keeps those slots longer and ratchets up to the full ceiling.
Because an admission entry is released by an advance rather than by a timeout, a gate held
shut by instances for a minute re-advances them — idempotent, and it both drops the lock of an instance
that is already finished and repairs one that cannot finish, so a stuck slot heals
instead of wedging admission shut. If a whole pass changes nothing, the engine logs
`admission gate held by instances that are not moving`: under a real backlog the open
set turns over constantly, so the same instances still being open a minute later is
the symptom worth a line.

**An advance therefore has to be able to repair, not just observe.** Two states look
like work in flight and are not, and both once held a slot permanently:

- A pooled step with no job behind it. The step node and the pool job are separate
  writes, so a crash between them — or a job dropped by hand — leaves a step nothing
  will ever pick up. `ready`/`claimed` is the whole of "in flight", so a step with
  neither is orphaned. A `waiting` one has no owner yet and only needs its job
  re-added; a `running` one was claimed by a worker that has since died with its job,
  and the worker-side staleness check drops any job whose step is not `waiting`, so
  that one goes back to `pending` and is pooled afresh. **A missing job is exactly the
  case a lease cannot cover** — nothing holds a lease, so no sweep is ever coming.
- An instance whose steps were never written (see the empty-steps guard below). Past a
  five-minute grace window that is a creation that died between the two writes, not one
  still in progress, and the instance is failed.

Both were found in production on 2026-08-22: 100 instances started 2026-08-07..10, each a
single pooled step reading `running` against a pool holding zero jobs, filling every
admission slot. The engine reported 74 trigger events queued, one completion in the last
hour, and an idle GPU. See ein/core#67.
(Those 74 were not in fact queued — they were 74 deliveries locked by consumers that had
died, which the queue counted as depth and had no way to reclaim. See **Queue leases** below.)

The trigger claim loop and `recover()` both wait on this gate, so work above the line
stays a durable pool row. That is the point of having a pool: a backlog should cost a
row, not a parked promise. Gating recovery matters just as much as gating new work —
the instances left `running` by an engine that died of too many of them are exactly
what recovery would re-dispatch all at once, turning a crash into a crash loop.
Recovery therefore also runs **in the background** off an indexed, paged query rather
than blocking startup while it lists every instance directory.

There is no separate job system: the engine runs each step command **in-process**,
throttled by a global semaphore (`CFG_PIPELINE_MAX_CONCURRENT`, default 4) shared across
all instances. Step completion advances the DAG directly (no event round-trip).
A step parked on the semaphore is re-validated once it gets a permit, as a pool worker
re-validates its job: it runs only if the node at its path is still the step it was
queued for, still `queued` on the same attempt. A cancelled instance leaves its step
`skipped`, and `pipeline start` on the same node puts a new step at the same path with
its own dispatch, so the old one drops out instead of running.
Per-step retry lives on the step node (`attempts`/`maxAttempts`); on restart, steps
left `running` are reset to `pending` and re-run (step commands are idempotent,
guarded by their `condition`). A pooled step is exempt while its job exists — the
lease is real crash detection and resetting would race a live worker — but not once
the job is gone, which is the orphan case above. The fresh job carries the runs the step
already had (`attempts` on the pool job input), so a step that kills its worker every time
runs out of attempts instead of starting its count over forever.

**Settling a pooled step writes the step node first and releases the pool job last.**
The two live in different stores and cannot share a transaction, so one has to land
first, and the two orders fail very differently. Step written but job not leaves a
`claimed` job nobody heartbeats: the pool's sweep reclaims it within
`leaseMs + sweepIntervalMs` and the next claimer drops it, because `staleReason` sees
a step that is no longer `waiting`. Job written but step not leaves the step `running`
with no lease to expire and no job to reclaim — the orphan above, repaired only when
something else advances that instance or the admission gate saturates enough to kick
it. So `PoolWorker` always writes the step first, in the failure path as well as the
success one, which means deciding terminal-versus-retry from the claimed job's own
`attempts`/`maxAttempts` (the rule `fail()` applies) and reconciling afterwards if the
pool's answer disagrees. The release itself is retried a few times, because on
`/var/pools/media` the leaked permit is `gpu=1` — the only one there is — and a transient
error should not cost a minute and a half of idle GPU waiting for the sweep.

**A step's exit code says whose failure it was** ([src/lib/step-exit.ts](../../src/lib/step-exit.ts),
ein/core#515). Any non-zero exit spends an attempt, as above, except two:

- `STEP_EXIT_TEMPORARY` (75) — a service the step needs could not do it yet: EMS busy, loading a
  model, restarting or unreachable. `PoolWorker` puts the step back to `waiting` with the attempt
  given back and hands the job back, and the kind rests: 30 s, doubling on each one after up to
  10 min, ended by the kind's next success or by `pool wake`. The rest is what holds the job back;
  a worker that names no kinds, and so cannot leave one out of its claims, releases the job with
  the pause as its delay instead. A down EMS is asked once per pause
  per kind instead of having a whole backlog spend its attempts in seconds, and nothing is failed
  however long it stays down.
- `STEP_EXIT_INPUT` (65) — the input is the problem (bytes no decoder can open): the step fails at
  once with `cause: 'input'` and the job with it, whatever attempts are left.

A step the engine runs itself, outside a pool (`document-index`'s `extract-text`), has no kind to
rest. On 75 it goes back to `pending` with the attempt given back and a `notBefore` 5 minutes
ahead; the engine does not dispatch it before then, and a timer advances the
instance at that time (re-armed by recovery after a restart). On 65 it fails at once with
`cause: 'input'`, as a pooled step does.

The bins that call EMS end with `stepExitCode(error)` from `@ems/client`, which maps EMS's answer:
`busy`, `model_unavailable`, `deadline_exceeded` and an unreachable EMS are temporary;
`undecodable`, `unsupported` and `not_found` with `permanent` are the input's;
anything else is 1.

**A batching worker holds a kind boundary for five minutes at most.** With `--kind-quantum`, a
worker leaving a kind keeps its free slots idle while the old kind's commands finish, so two large
model families are not started together as a batch turns over. Past five minutes the old kind's
last command is a long one — a diarize over a long video — and the free slots go to the next kind
beside it rather than waiting it out (ein/core#511).

**No step is stopped for taking long** (ein/core#358). A step runs to its end
however long that is: a long step is working, and stopping it throws the work away and
does it again. Both the engine and `PoolWorker` run steps through
[src/managers/pipeline/step-run.ts](../../src/managers/pipeline/step-run.ts), and only
the caller hanging up stops one — a pool worker stopping, or losing the job's lease. The
hang-up is passed _into_ `runAndCapture`, which arms an abort signal on that call's own
capture sub-context; `Shell.waitForCommand` bridges it to `signalPid(id, 'SIGTERM')` for
every command started under that context, so one step of a `--concurrency 4` worker is
stopped without its siblings. A tool that ignores SIGTERM is abandoned 30 seconds later,
so a stopping worker still stops.

What takes the deadline's place is a report. `runAndCapture`'s `onOutput` hears every
chunk a step writes, and `markOutput` keeps the step node's `outputAt` within a minute of
the last one. `pipeline-overview` lists as `quiet` every running step that has written
nothing for `CFG_PIPELINE_STEP_QUIET_MS` (30 minutes), and the system page shows them as a
warning; a person decides whether one is stuck. Bins that run as steps narrate their
phases through `stepPhase` (`@ein/client`), which writes `<bin>: +<ms> <label>` to stderr
only when captured or `-v`: those lines keep a slow step off the quiet list, and are a
failed step's account of how far it got. A step that never settles holds its semaphore
permit, or its pool capacity, for as long as it runs — the quiet list is how that shows.

**`health` says, in one word, whether the work is well** ([health.ts](../../src/managers/exec/commands/system/health.ts),
ein/core#515): `healthy` when nothing is waiting, `catching-up` when work is waiting and
some finished in the last hour, `stuck` when none did, and `needs-person` when a check failed. Its
checks are one per pool kind with something waiting — draining, resting because EMS could not run
it (with the next try), or with no worker — failed instances that `pipeline
heal` is running again (`warn`) or has marked `needsPerson` (`fail`), steps that met input nothing
can process, quiet steps, dead-lettered queue entries, and whatever running services answer through
their `checkCommand`. `pool-stat` gives each kind the figures this reads — `oldestReadyAt`,
`restingUntil` —
and the system page's header badge carries the verdict, its Overview the checks that are not `ok`
(nothing while they all are), and `top` leads with both.

A hung-up command may still be writing while the capture pipe it writes into is being
torn down — `Shell.pipeRead` sends EOF on abort so a writer parked on a full pipe can see
the close and unwind.

An instance is built instance-node-first, then its `steps` directory, then the step
nodes — and the instance node's own `created` event schedules an advance, so the
advance races the step creations that follow it. An **empty steps directory therefore
means "still being built", never "done"**: without that guard the terminality check
(nothing pending, nothing running) was trivially true, the instance was marked
`completed`, and the steps appeared a moment later as `pending` under a terminal
instance that no later advance would ever touch again. `pipeline repair` finds and
re-runs instances stranded that way. The guard reads "still being built" only inside a
five-minute grace window; past it the steps are not late but absent, and the instance
is failed rather than left holding an admission slot forever.

**An instance's subject has to still be the node it was created for.** Creating an
instance already requires that — the instance is named after the node's id — and a
pooled step re-checks it when a worker claims the job. The third place is an advance
about to dispatch an _inline_ step, which used to check nothing: deleting a file while
its pipelines were in flight stopped none of them, and the first later step to write a
child rebuilt every missing ancestor as a `directory` (`mknode -p`). The deleted
subtree came back as a husk of empty directories, and so did the album above it — as a
`directory`, not an `album`, so the album page and `search --under` no longer
recognised it. An advance that finds its subject gone now cancels the instance: every
step that could still run is marked `skipped` and the pool jobs behind them are
dropped.

The comparison is on **identity**, against the `triggerNodeId` recorded at creation,
not on the path existing. Those differ exactly when it matters: once anything has
rebuilt the path, an existence test is satisfied by the husk from then on. Instances
predating `triggerNodeId` — and `pipeline-repair`'s hand-built fixtures — carry none
and fall back to existence.

Bounding the writers is the other half, because an advance cannot see a node deleted
_during_ a step it already dispatched. `mknode -p` is `mkdir -p`: it creates every
missing ancestor, which is what boot needs and what a derivative writer must never do.
`mknode --under <path>` names the deepest node the caller already knows exists and
bounds ancestor creation to what lies below it, so a subject deleted mid-step fails the
write instead of resurrecting a tree. Every media writer under a subject path passes
it; for most of them `-p` was only ever asking for "do not fail on an existing node".

**Pool-delegated steps.** A step may declare `pool: <name>` with `kind`,
`requires`, `priority` and `exclusive`. Instead of running it inline under the shared
semaphore, the engine marks the step `waiting` (no permit held) and adds a job to
`/var/pools/<name>` keyed on the step path. A long-lived **`pipeline-worker --pool`**
service offers its remaining capacity (`--capacity models=4`)
and the pool hands back the best job that offer can actually run: highest
`eff_priority` first, oldest within a priority, skipping anything whose `requires`
exceeds the offer or whose `exclusive` class is already held.

Scheduling therefore lives on the jobs, not in the transport. Priority is per job, so
one urgent file can outrank a backfill of the same pipeline; capacity is per worker,
and the worker's concurrency remains the hard job-count ceiling. The 32 GiB production profile
offers five CPU slots through six workers and four model slots through the `models` worker.
Two of the five CPU slots are a **soft non-entry reservation**: above that boundary
normal priority lets ingest run first; at the boundary the worker probes stills, face
assignment/transfer, fingerprint and transcode in round-robin order before
ingest. If none is waiting, ingest immediately borrows the capacity, so an empty
downstream lane never idles a core. When it is a kind's turn and what it has ready needs
more than the reserved share offers — a two-slot transcode while a one-slot stills job already
holds one of the two reserved slots, which under a crawl is the permanent state — the worker
lets it take from everything that is free and, if that is still short, **accumulates**:
it admits nothing else until completions have freed enough for the weighted job, then
claims it. Without that hold the weighted job only ran when two slots happened to free at
the same instant, which with six workers refilling the pool never happened. The hold is
capacity-specific: a job that fits already but was refused for another reason (an
`exclusive` class held elsewhere) is not held for, and the hold is dropped as soon as no
job of that kind is waiting on capacity. `accumulatingFor` in the worker state names the
kind being held for.
When every offered resource is exhausted, the claim loop waits for a completion
before asking the pool again. It must not leave a blocking zero-capacity claim
parked in the registry: that request could be retried against a later mutable
offer and bypass the reservation decision that should run when capacity returns.
This is worker-local admission over one capacity budget, not a second worker or pool, so
weighted requirements cannot oversubscribe the host and a two-slot transcode still costs
two of the same five slots. The reservation is visible in `pool-stat`'s `workers`.
A model
slot is one request in flight against EMS — the model-family locks and the CPU fallback all live
on the EMS side. Remote host profiles pass
the slot count through the container environment into the initial service shell, and boot
persists it in `/etc/bashrc` for later service restarts. Retuning priority is an attrs or
YAML edit rather than a service restart.

Model kinds rotate after a configurable quantum (`CFG_MODEL_KIND_QUANTUM_MS`) to prevent a
continuous faces backlog from starving the other kinds. With concurrency above one, reaching the
quantum or draining the ready queue first waits for every in-flight command of the current kind
to finish, then starts the next kind. The rotation is purely an anti-starvation bound: EMS holds
every model resident (measured co-residency in production, 2026-09-06) and a kind switch evicts
nothing.

The worker re-validates each job at execution time (instance still running, step still
`waiting`, target node still the same node) and drops stale ones, so `pipeline cancel` still works
by setting the step `skipped`; removing an instance additionally cancels its jobs,
since a pool job is a durable row that outlives the step node it points at. A claim
takes a **lease** the worker renews while it runs: a worker that dies stops renewing
and the pool's sweep returns the job within seconds, replacing the old
reset-on-engine-restart heuristic. Because the job is keyed on the step path and
upserted, the step and the job cannot drift into disagreement — a step left `waiting`
with no job behind it is restored by the next advance instead of stalling forever.
Losing the lease hangs up the step's command, so the next claimer never runs
beside it. On a planned worker stop, the worker hangs up every running step at
once, waits for those runs to end (a command that ignores SIGTERM is abandoned
after the kill grace), and only then restores each claimed step from `running`
to `waiting` and releases its job back to the pool, with the attempt the claim
counted given back, so no run is still writing to a step or job while it is
settled, and a restart does not use up a step's retries. The replacement worker can
therefore reclaim it immediately; releasing the job first would make the new
worker reject it as stale and leave a false-running orphan until a broad engine
recovery sweep found it.

A pooled step's times keep the wait apart from the work. `waitingSince` is stamped
whenever the step goes into its pool's queue: when the engine pools it, when a failed
run is handed back for a retry, and when a stopping worker returns it. `startedAt` is
stamped only when a worker claims the job and the step goes `running`, along with the
pool's `attempts` for that job. The instance page times a `waiting` step from
`waitingSince` and marks one with attempts behind it as retrying, so a step deferred
behind a backlog reads as waiting since its last run, not as one long run.

Container shutdown preserves that path: the primary process catches SIGTERM and
signals all services in parallel, so a slow pipeline-engine stop cannot prevent
the pool workers from releasing their jobs. Podman allows 60 seconds for this
cooperative teardown before SIGKILL instead of its ten-second default.

Step commands are module binaries (e.g. `exif-extract` in `/usr/modules/archive/bin`), found
via the engine or pool worker shell's `PATH`. `mod setup` appends each module's `bin/` to
`/etc/bashrc`, which their shells source again before the next step after it changes, as they
do after any settings change. A module set up after boot is therefore visible to
already-running inline and delegated pipeline steps without restarting either service. Likewise, the engine reloads its pipeline definitions
when anything under `/var/pipelines/definitions` changes, so `pipeline define` (or a post-boot
`mod setup`) takes effect without an engine restart.

One definition can carry a `triggers:` list. Each alternative has its own `match`,
`unless`, `filter`, `skipIf*`, `allowDerived`, variable overrides and scheduling priority; the
first matching alternative starts the pipeline. The singular `trigger:` form is the
same model with one alternative, and alternatives that differ only in their event share
the rest through a YAML anchor (`- <<: *trigger` then `event: moved`, as `document-index`
does). The guards run cheapest first. `match` (start only when every key's glob matches) and
`unless` (skip when every key's glob matches) are declarative and cost no process: a key names
a variable of the trigger env below in camel case, `$EVENT_<NAME>` before `$<NAME>`, so
`mimetype` reads a fact's `$EVENT_MIMETYPE` and a VFS event's `$MIMETYPE`, and `nodePath` the
`$NODE_PATH` of both; a list of globs matches when any does. In a path key (`nodePath`, any key
named `path` or ending in `Path`) `*` matches within one name and `**` crosses `/`, so
`/home/*/staging/**` is each user's staging inbox and not a folder named `staging` deeper in a
home; in any other key `*` crosses `/` as in a shell `case`. Then come the derived-file guard, `skipIfExists` and `skipIfAttr`, a node read, and
last `filter`/`skipIf`, shell scripts run once per candidate event on the engine's shared
shell. `unless` is what keeps a busy subtree free: `document-index`'s `unless` on `nodePath`
(staging, `/var`, dotfiles and the trash among others) makes a write there cost no shell
evaluation.
A **fact** trigger exports `$NODE_PATH`
(the subject), `$EVENT_TYPE`, `$EVENT_ID`, `$EVENT_SOURCE`, `$EVENT_DATA` (the whole
`data` as JSON) and each `data` key as `$EVENT_<UPPER_SNAKE>`. A **VFS** trigger
exports `$NODE_PATH`, `$MIMETYPE`, `$NODE_TYPE`, `$EVENT_TYPE`, with the mimetype read
fresh from the node. Deliberately `$NODE_PATH`, not `$PATH`, since the engine shell is
shared and exporting the node path as `PATH` would clobber executable resolution.

Step `condition`/`command` get the same names: `$NODE_PATH` always, plus `$EVENT_*`
when the instance was fact-triggered (the event is persisted on the instance node, so
they survive a restart, `pipeline restart` and `pipeline rerun`). Anything else a step needs it reads
from the node itself — e.g.
`JSON_OUTPUT=1 attrs "$NODE_PATH" | jq -e '.mimetype | startswith("image/")'` — gated by
`dependsOn` so the value is set before it's read. This keeps the engine free of domain
attributes and avoids stale captured values across DAG advances (a step's condition may
be evaluated on a later advance than the one that created the instance).

`pipeline start` creates an instance with no event context, so a step that depends on
`$EVENT_*` is only safe in a pipeline that is never started by hand. Because substitution
is total, a name with no value reaches the shell as nothing at all — `assign-faces
$EVENT_FILE_PATH` runs as a bare `assign-faces` and the instance fails as though the work
had been attempted. Both creation paths therefore name what they cannot supply: they warn
on stderr and, in JSON mode, return `missingEventVars`. `pipeline rerun` carries the stored
event over, so only a hand-started instance — or one created before the event was
persisted — has anything missing.

**Per-instance variables.** A definition may declare `vars: {NAME: default}`, interpolated into
step commands like the trigger names and overridable for one run with
`pipeline start <p> <path> --var NAME=VALUE`. The resolved set is written to the instance node
(so the engine substitutes without re-reading the definition, a run keeps the values it started
with, and `pipeline status` shows them) and carried through `pipeline rerun`. A variable is
substituted as exactly one shell word; an empty value expands to nothing at all, so an unset
optional flag does not become an empty argument. Declaring them is what makes substitution
total — an undeclared `$FOO` would survive into the shell — and a `--var` the definition does
not declare is an error rather than a silent no-op. Names the trigger owns (`NODE_PATH`, `PATH`,
`MIMETYPE`, `NODE_TYPE`, `EVENT_*`) are rejected at parse time and the trigger wins regardless.

A trigger alternative may override declared variables and `priority` for the run. Those resolved
values are persisted on the instance too, so delayed trigger-pool admission, recovery and
`pipeline rerun` retain why the run was started. `media-transcribe` uses this to select `-f`
and priority 10 for `media.transcript.stale`, while ordinary ingest keeps the empty flag and
priority 50.

This is how one file gets treated differently from the crawl: `media-transcode` carries no `-f`,
so the crawl keeps skipping files that already have a rendition, while its `media.file.turned`
trigger sets `FORCE: -f` for a video turned by hand — the old rendition stays playable
(sideways) until the queued re-encode replaces it, instead of being deleted to make the pipeline
redo the work. `pipeline start --var` does the same for one instance, from the administrator's
shell.

**Paths with spaces.** The two injection mechanisms differ, so YAML must quote `$NODE_PATH`
differently in each: a step `command` is built by _string-substituting_ `$NODE_PATH` with
the shell-quoted trigger path (`shq()` in `lib/shell-quote`), so the YAML writes it bare
(`transcribe-file $NODE_PATH`) and the quoting is supplied by the substitution. A `filter`/
`skipIf`/`condition` runs with `$NODE_PATH` _exported_ into the shared engine shell, so the
YAML must quote it itself (`info "$NODE_PATH/exif"`). Module bins that re-interpolate a path
into a further command string quote it with `shq` too.

**Self-inflicted triggers (general).** A pipeline's steps typically mutate the trigger node
(write attrs, add child nodes), which re-emits `updated` events that re-match the trigger.
The engine suppresses these **generically**, without knowing what the pipeline writes: a
trigger for `(pipeline, triggerPath)` is skipped if the node's single instance is still
`running`, or if the event's timestamp falls inside that instance's
`[startedAt, completedAt + SELF_TRIGGER_GRACE_MS]` window (all step writes land before the
instance is marked completed; the grace covers async emission and clock skew). An
independent change _after_ the window (the user edits the file later) is past the window
and starts a fresh run (replacing the prior instance, via one-per-node). This is
`isSelfInflictedTrigger` in the engine — it replaces the old "skip while running" dedup and
means pipelines no longer need a per-pipeline marker node to avoid re-triggering
themselves. (Pipelines may still use a `skipIf` marker for a _different_ purpose — declining
expensive re-work on a legitimate external re-trigger — but that is an author policy choice,
not the mechanism that stops self-retriggering.)

**Coalescing by rerun (`options.coalesce: rerun`, `options.debounceMs`).** The guard above is
right for a pipeline whose subject is one file and wrong for one whose subject is an
_aggregate_ announced once per member — `media-album`, whose fact is derived from an album's
members and never from the album's own writes. There the first photo of a crawl starts the
instance, the next 999 land while it runs, and dropping them leaves the album stale the
moment the run ends. A definition that sets `coalesce: rerun` skips the self-inflicted check
(and its grace window) and, once a trigger has passed the guards, `admitTrigger` either
enqueues it or — when the subject's instance is live — writes it onto that instance as
`rerun` (`PendingRerun`: the event, vars and priority) and stops. When the instance goes
terminal, `rerunIfRequested` re-announces the subject from that record, so every arrival
during a run is one further run. Both sides re-read after writing so the race between a fold
and a completion cannot lose the trigger; at worst both enqueue and the pool's dedup makes it
one job. `debounceMs` is the other half: it holds the (deduped) trigger job in `/var/pools/triggers`
for that long from its _first_ announcement (a re-add keeps the earliest `availableAt`), so a
burst before any instance exists collects into one run. A definition choosing `rerun` is
stating that nothing its steps write re-emits its own trigger, and is responsible for keeping
that true.

**Derived outputs.** A step that creates new file nodes (face crops, thumbnails,
transcodes) sets `sourceId` to the node they were made from, and so does a
`versions/` member — the RAW `raw --sort` files behind the JPG of the same shot. A
derived node is a _different_ node, so the self-inflicted window above does not cover
it — without a guard a face crop (an `image/*` file) would trigger indexing →
detect-faces → another crop, forever, and a RAW version would be embedded and
face-detected a second time under a different node, silently doubling both the work
and the search hits.

The engine states this once, in the guard chain: a trigger whose subject carries
`sourceId` (`isDerivedFile` in `vfs/types/file.ts`) is dropped unless the definition
sets `trigger.allowDerived: true`. It is tested on the attr rather than on a
`versions/` path segment so it does not depend on where the node is linked. The media
bridge's `isIndexableMedia` still drops derived nodes when deriving facts, which keeps
the event off the queue in the first place; the engine guard is what makes the
invariant hold for any _future_ path that announces a file node's children, since
until now it held only by accident — `media-scan` does not descend into a file node's
children, and `raw --sort` re-emits nothing when it moves a file. `pipeline start` is
unaffected: it creates the instance directly and never passes the trigger guards, so a
derived file can still be indexed deliberately.

`pipeline start`/`pipeline restart`/`pipeline rerun` run in a _different_ shell than the
engine service, so they only write VFS state (create an instance, or reset failed steps +
set status=running). The engine reacts to the instance node's `created`/`updated` event
off its queue and re-advances the DAG — execution always happens in the engine, not the
caller's shell.

**One instance per node.** An instance directory is named after its **trigger node's
id**, so at most one can exist per `(pipeline, node)` — the invariant is structural
rather than something each creation path searches for and cleans up. Every lookup is a
direct `get` on `/var/pipelines/instances/<pipeline>/<nodeId>`, including the
self-inflicted-trigger check, which previously scanned a directory that reached ~126k
children during a crawl. An automatic re-trigger (re-upload, re-index) or an explicit
`pipeline rerun` therefore _replaces_ the previous instance in place, keeping its id.
Management commands:

- `pipeline rerun <id…>` — replace an instance with a fresh run from the _current_
  definition (picks up edited steps).
- `pipeline remove <id…>` — delete instances; a running one is cancelled first.
- `pipeline prune [name]` — bulk-delete terminal instances (completed/failed/cancelled);
  `-s <status>` targets one status, `--all` includes running (cancels first).
  `--keep <n>` switches it to a **retention cap**: keep the n most recently completed
  per pipeline and drop the rest, paging `vfs.query` on `completedAt` rather than
  listing the directory it exists to bound. A running instance has no `completedAt`
  and `vfs.query` excludes rows lacking the ordering attr, so retention structurally
  cannot touch live work. `--older-than <duration>` is retention by age: remove those
  completed longer ago (`30d`). Given both, an instance goes when either bound says so,
  so at most n survive and none older. `--max <n>` bounds the sweep **per pipeline**, so a large
  first pass converges over several cycles and the biggest directory does not absorb
  the whole budget. `--budget <duration>` bounds it by wall time too: the pipelines
  take turns a page at a time, and no page is started after the budget runs out. The
  `pipeline-pruner` core service runs, hourly, `pool purge --older-than 24h` on every
  pool and then `--keep 2000 --max 2000 --budget 15m` — before it existed nothing ran
  prune at all, and `media-ingest` reached 24,427 instances in one directory. The
  purge goes first because it is cheap (batches of 5000 rows, each its own
  transaction, and a delete leaves the pool's counts alone so `done` never falls) and
  it shrinks the tables every claim reads; behind an 80-minute instance prune
  the trigger pool once waited at 1.34 M rows. Size `--max` against the _completion_
  rate: removing an instance costs ~278 ms (recursive unlink of the instance, its
  `steps` dir and one node per step), and at the original 500 the pruner removed
  less per hour than a busy pipeline completed, so the cap was never reached.
  Retention leaves failed instances alone (only `--status failed` removes them): on a busy
  pipeline the cap removed a failure within the hour, before anything could look at it.
  A prune of the whole tree without `--status` also **retires** pipelines that are no longer
  defined — renamed or removed, so nothing can run their instances again: every instance,
  failures included, then the directory with its banked total, so `pipeline-overview` stops
  listing the old name. The first prune that finds a definition missing only marks the
  directory (`undefinedSince`); one at least 10 minutes later retires it if it is still
  missing, rechecking before each page. `pipeline define` unlinks and relinks a definition,
  and `mod setup` redefines every pipeline it ships, so a definition seen missing once may be
  in that gap.
- `pipeline heal [--apply] [--now]` — run failed instances again once their cause may have
  passed (ein/core#515). Each is rerun after a wait that grows with every heal (1 h,
  6 h, 24 h) through the same path as `pipeline rerun`, the count carried on the new instance
  as `healAttempts`; one that fails through all of them is marked `needsPerson` and not looked
  at again. A step that failed on its input (`cause: 'input'`) is never rerun, nor an instance
  of a pipeline no longer defined (`retired` in the report), which the prune retires. `--now`
  skips the waits, for a cause known to have passed. The `pipeline-pruner` service runs
  `pipeline heal --apply` hourly, before it purges and prunes.
- `pipeline undefine <name>` — remove a definition and cancel its running instances at once: an
  instance runs from the steps it was created with, and its pooled steps would otherwise be
  queued again under kinds no worker may offer any more. `mod setup` undefines a pipeline its
  module no longer ships. Finished instances are left to the prune.
- `pipeline cancel <id>` — set a running instance's status cancelled, then mark its steps
  skipped and drop their pool jobs. It runs outside the engine's per-instance lock, so an
  advance re-reads the instance after writing a step `waiting`/`queued` and skips the step
  itself if the cancel got there first; re-reads the step after adding its pool job and drops
  the job if the step was skipped meanwhile; and writes the instance's status only while it is
  still the one the advance read (`updateMany`'s `guard`), so the cancel's `cancelled` is never
  written over.
- `pipeline restart <id>` — resume a failed/cancelled instance by re-queuing only its
  failed steps (distinct from `rerun`, which replaces from the definition).

The UI `/system/pipelines/<pipeline>` page exposes these as multiselect bulk actions (Rerun / Cancel /
Remove) plus a Prune button; the instance detail page has per-instance Rerun / Cancel /
Remove.

```
Upload lands: the PUT handler writes size/sha256/mimetype
  → VFS event on system.vfs.file.updated
    → /var/queues/archive-bridge (durable; binds only the keys the rules need)
      → archive-bridge applies event-rules → media.file.discovered → /dev/events
        → /var/queues/pipeline-engine (durable, triggers only)
          → PipelineEngine matches `on:` + filter
            → /var/pools/triggers job, dedupKey media-ingest/<nodeId> (re-announce = same row)
              → engine claims → /var/pipelines/instances/media-ingest/<nodeId>
            → advanceDAG: for each ready step:
                inline step     → mark 'queued', acquire a semaphore slot (cap N),
                                  re-validate, run in-process, capture exit code,
                                  mark completed/failed (retry)
                pool: media → mark 'waiting', add job to /var/pools/media (keyed on step path)
                                    → pipeline-worker consumes, re-validates, runs,
                                      writes the step node
                                        → engine sees it in-process → re-advances
            → exif-extract writes <file>/metadata/exif
              → bridge derives media.metadata.extracted
                → media-stills, media-fingerprint, media-faces, media-device,
                  plus media-transcribe for video/audio
                    → detect-faces writes <file>/regions/face-N (+ embedding child) for each face passing the quality gate, marks <file> facesAt
                      → bridge derives media.face.detected (one per face)
                        → media-face-assign
                      → bridge derives media.faces.completed (also when zero faces)
                        → media-speaker-faces, for a video whose voices are already printed
```

Nothing in that chain waits on "the previous step finished" — each stage waits on a
fact, which is why a capability can be re-run, re-prioritised or given its own resource
queue without touching the others.

## File upload

```
UI: POST /file/albums/2024/?name=photo.jpg  (bytes)
  → handlePostFile
    → VFS.create photo.jpg, or photo (2).jpg, … when the name is taken
    → stream through sha256 hash transform
    → detect MIME from first bytes
    → write to file registry (disk)
    → VFS.update node attrs (size, mimetype, sha256)
  → 201 + { path, renamed, …attrs }
```
