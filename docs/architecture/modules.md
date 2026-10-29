# Module System

Part of [EiN Architecture](../architecture.md), which holds the core: topology, VFS, registries, managers, commands, node types, boot and servers.

Modules extend EiN with domain-specific commands, services, and pipelines. They are designed to have no hard dependency on core internals. Every `mod.json` field is described in [the manifest reference](module-manifest.md).

**Each module is its own repository** (`ein/module-<name>`), and core names none of them; the
image carries none. A module reaches an instance in one of two ways, and boot links both into
`/usr/modules` and sets them up (`04_modules.sh`): the deployment mounts a folder of module
checkouts at `DEV_MODULES_PATH`, or the administrator installs one from its repository with
`mod install`, into the folder mounted at `/var/lib/modules` ([below](#installing-a-module-from-its-repository)).
For development a checkout's `modules/<name>` holds module checkouts, which this repository
ignores: the workspace, the test tiers, `check:bins` and `ui-build` take whatever is there, and
with nothing there core's own tests still run. `system-info` says each module's commit beside
core's, from the deployment's `src/build.json`, the checkouts' git or an installed module's
record.

```
modules/<name>/
  mod.json          manifest — every field in module-manifest.md
  deno.jsonc        workspace member config, generated from mod.json — `deno task sync:modules`
  bin/              commands (shell scripts or #!ts)
  services/         background services (start.sh + config.json)
  pipelines/        pipeline definitions (.yaml)
  types/            node attr type definitions
  ui/               its routes (ui.routes) and navigation entries (nav.json)
  docs/             end-user markdown (symlinked to /usr/docs/modules/<name>)
```

**Core is no module.** Core's own commands in bash (`mkdir`, `mkfile`, `mkqueue`, `www` …), its
services (http, ssh, the pipeline engine, the reapers), the seed `/etc/bashrc`, the terminal page and
the browser shell are core's files under [src/builtin/](../../src/builtin/), which boot mounts
read-only at `/usr/lib` (ein/core#591). Core sets them up itself before any module, in
`03_core.sh`: it seeds `/etc/bashrc`, registers and enables the services, and links the terminal page
and the built shell into `/var/www` and the shell's navigation into `/etc/ui/nav.d`. Its settings are
`CORE_OPTIONS`, its indexes the store's own and its root, `/archive/tags`, is made by `02_archive.sh`.
The shell's commands (`ui-build`, `ui-nav`, `ui-icons`) are core commands in `/usr/bin`. `mod list`
lists modules only, so neither the About dialog nor the Modules settings show core as one. The built
shell, gitignored, is mounted from the checkout over the image's copy so a UI-only deploy needs no
rebuild. [src/modules/repo.ts](../../src/modules/repo.ts) is the one place that knows core's files
sit under `src/builtin/` and every module under `modules/`.

`mod setup` ([src/managers/exec/commands/mod/mod-setup.ts](../../src/managers/exec/commands/mod/mod-setup.ts))
wires each of these folders into a shared VFS location; `mod remove` reverses them.
`mod setup --all` first forgets modules whose code is gone — a `/usr/modules/<name>` link to a
directory a deploy removed — undoing the bashrc line, services, pipeline definitions and `/var/www` and
docs links that point into it, since `mod remove` needs the module's own directory to know what to
undo ([prune.ts](../../src/managers/exec/commands/mod/prune.ts)). It then walks every installed module in dependency order — alphabetical order is wrong,
since `archive` depends on `ems` and sorts before it — and is what boot calls. Each module is a
failure boundary: a refused setup, a failed setup effect, or an unexpected exception is logged and
collected while later independent modules continue. The aggregate command still exits non-zero so
callers can see the degraded boot.
Each module's outcome is also kept in memory ([setup-state.ts](../../src/modules/setup-state.ts)),
with the reasons it failed, and `mod list` reports it as `setup` — absent for a module not set up
since EiN started. Installed is not the same as working, and before this a failed module was visible
only as a log line at boot; the Modules tab of the settings page reads it from there.

Pipeline definitions are softlinks back into the owning module's `pipelines/` directory. Setup
reconciles those owned links against the current YAML names after registering them, so deleting,
renaming or folding a definition retires the old live trigger on upgrade. A link targeting another
directory is operator-owned and untouched; a failed current definition suppresses reconciliation
for that module rather than removing its last working version from a partial view.

Services follow the same ownership rule. A registration is a softlink under
`/etc/services/available` into the module's `services/` directory — or, for a single-script
service, into an `/etc/service-scripts/<name>` wrapper whose `start.sh` links there. After
registering the current set, setup stops, disables and removes every owned registration whose name
the module no longer ships, so a dropped or renamed service does not stay enabled and fail to start
on every boot. A registration added by an operator with `service add` points elsewhere and is left
alone.

Module services declare `restartPolicy: "on-failure"` in their `config.json`. The service manager
then permits three restarts in a rolling 60-second window by default, so a killed long-lived service
recovers while a broken start script eventually stays failed. An explicit stop never invokes the
restart policy.

A stop hangs the script up, not only the command it is in: the manager runs `start.sh` under an
abort signal of its own and aborts it alongside the SIGTERM, so a `while true; do …; sleep 3600;
done` service ends at the interrupted `sleep` instead of starting its next pass — the same bridge
`Shell.runInBackground` gives a backgrounded loop. The manager then waits on the script's exit
rather than polling for it, and only a script that never exits pays the `stopTimeout` grace (5 s
default) before being force-closed.

A service may also declare `statusCommand` there — a command reporting its own health in one line,
which `service-list --detail` runs for running services and returns as `detail` beside the status. Core
never learns what the line means; it exists because `running` is the only thing the manager can say,
and for some services that is the uninteresting half. The media service can be up and waiting for
room on the card for every transcription, which is invisible from outside and looks exactly like a
slow crawl; `ems-link`'s line says so.
First line of stdout wins regardless of exit code — a service reporting that it cannot reach its own
socket has said something worth showing — and a failure or a timeout (2.5 s) is silent. Stopped
services are not probed. `pipeline-engine` also has a 16-minute graceful-stop timeout: its shutdown waits for
inline steps, which have no timeout of their own, before closing queue and event handles.

Two more such commands answer in JSON (they are run with `JSON_OUTPUT=1`; the types are `HealthCheck`
and `Gauge` in `@ein/client`). `checkCommand` answers checks on what the service watches —
`[{ name, state: 'ok' | 'warn' | 'fail', reason }]` — which core's `health` adds to its own; `fail`
means a person has something to do, and a check that does not answer is a `warn` against the service.
`gaugeCommand` answers meters — `[{ label, percent?, value }]` — which `top` draws beside the host's
RAM and the `gauges` command lists. ems declares one of each: `ems-status --checks` on `ems-link`
(whether EMS answers, its model worker, each degradation, the card) and `ems-gpu --gauge` on
`gpu-sampler` (the card's utilization and memory). The assistant declares `llm-status --checks` on
`llm-link` (whether its language model answers, whose it is and where it runs, and whether the
model is one it was tried with).

**The shell, and the pages modules bring.** The browser app's shell is core's (`src/builtin/ui`):
the frame, the router, the kit of shared components, hooks and signals, and the shell's own pages.
It names no module and runs no module's command (ein/core#442): what it shows of a module's
comes through that module's routes, panels and `ui.open`, and what it asks of one through core —
`search`, `parse-search`, `docs find`. A module's own pages live under its `ui/` and reach the
kit not by importing the shell's files but through the running shell, which lends React, Mantine, a
client subset of react-router, the signals packages, `@ein/paths` and the kit (`@ein/ui/components`,
`/hooks`, `/lib`, `/signals`, `/theme`) on `globalThis.__EIN_UI__`
([shared.ts](../../src/builtin/ui/lib/shared.ts), set by [lend.ts](../../src/builtin/ui/src/client/lend.ts)), so one React renders everything. The
boundary test asserts that a module's pages import nothing else of the shell's, and that React and
Mantine are imported only under a `ui/` directory. Every module's pages are its own since
ein/core#427 and #442; the shell keeps the home page, docs, settings, the system dashboard,
statistics and the node explorer. A module gives navigation entries and routes,
nothing else: an entry opens a route as the page, in the shell's dialog, in its drawer or full screen — the
Create menu's rows are `dialog` entries for each module's `new` route (ein/core#439) — or,
as a `panels` entry, inside another page at a slot that page names (the explorer's tools, the
dashboard's tabs, the statistics page's sections; [UI](ui.md#navigation)). A route an answer names is
drawn the same way: a chat card, an entry on the home page.

**Module pages.** A module lists its routes in `mod.json`, each path with the page file that draws
it: `"ui": { "routes": { "/devices": "ui/pages/devices.tsx", "/devices/:id": "ui/pages/device.tsx" } }`.
A path is absolute below `/`, of literal and `:param` segments; `/` itself is the shell's home page. A page's default export is its
component; it may also export `handle`, `loader`, `action` and `ErrorBoundary`, which become the
route's. A module route may sit under one of the shell's — media's `/albums/new` beside the shell's
`/albums` and `/albums/:id`. One at the very path of a shell route is never reached (the shell's is
matched first, and the shell says so in the console); a path two modules give is refused when the
manifest is written, for the module later by name. They are bundled inside the running EiN by core's `ui-build`
([module-build.ts](../../src/builtin/ui/lib/module-build.ts)), from the installed module in the VFS:

- it follows the imports from the pages and allows only what the shell lends,
  the module's own files — CSS and CSS modules included — through relative paths or its own
  `imports`/`exports`, and anything at all behind `import type`; no npm and no network, so a build is
  the module's few files (device: 66 KB, under three seconds on fry);
- it stages them with a one-line shim per lent specifier and runs `deno bundle`, unminified: the
  minifier renames CSS-module classes to letters that are unique within a bundle but collide
  between modules' stylesheets in one page, and staging prefixes each CSS module with the module's
  name for the same reason;
- the JS and CSS go to `/var/cache/ui/<module>/<sha256>.js|css` (served with an `immutable`
  Cache-Control), the routes to `/var/cache/ui/manifest.json`, and the key it was built from to
  `build.json`, so an unchanged module is not rebuilt.

The shell's router knows a module's routes from the manifest before any of its code is loaded
(`patchRoutesOnNavigation`, [module-ui.ts](../../src/builtin/ui/src/client/signals/module-ui.ts)),
and loads the module's stylesheet, then its bundle, the first time one of its routes is
opened, as the page, in the dialog, in the drawer or full screen. Until a router has patched them
in, it draws its root's fallback rather than the shell routes matching the start of the path
(`awaitModuleRoutes`): `/system` for `/system/gpu` would draw the dashboard inside its own GPU
panel. A path no route matches lands on the root's `*` child, which the router does not take as
final — a splat's match has a parameter, so it asks for module routes first — and draws "Nothing
here" inside the frame; a module page whose bundle cannot be loaded (`ModuleLoadError`) or that throws
ends on the root's error page, also inside the frame, which offers a reload
([RouteProblem.tsx](../../src/builtin/ui/src/client/components/RouteProblem/RouteProblem.tsx)). The
dialog, drawer and full-screen surfaces draw the same, smaller. A page says it is drawn edge to edge
with `export const handle = { fullBleed: true }`; any other gets the frame's `md` gutter.
`sync:modules` gives a module with pages the lent specifiers' type paths in its `deno.jsonc`, so
`deno task check` covers its pages; at runtime nothing reads them.

**Opening a node.** The shell links nodes it finds but does not own — search results, the header's
completions, the node explorer's Open, a person on a family tree — through the route a module says
opens that node type: `"ui": { "open": { "person": "/people/{name}", "album": "/albums/{path}" } }`,
`{name}` the node's last path segment and `{path}` its whole path. `ui-build` carries it into the UI
manifest, the shell reads it with the navigation (`openRoute` in
[module-ui.ts](../../src/builtin/ui/src/client/signals/module-ui.ts)), and a type no installed module
names is simply not a link (ein/core#442). `completion-entity` answers each hit's node type
for it.

**Navigation.** A module's sidebar and top-bar entries are its `ui/nav.json`, which `mod setup`
links as `/etc/ui/nav.d/<module>.json` (owned by link target, like its services; `mod remove` and
the prune undo it). The administrator's `/etc/ui/nav.json` and each user's `~/.ui/nav.json` are laid
over them; `ui-nav` resolves the layers for the reader ([nav.ts](../../src/builtin/ui/lib/nav.ts),
[UI layer](ui.md#navigation)). `mod setup` links a module's `ui/` into `/var/www` only when it is a
built site (`ui/index.html`), and retires a link of its own that points at anything else, so page
sources are never served under the module's host name.

**Rebuilding pages.** `mod setup --all`, and any single `mod setup` or `mod remove`, end with
`ui-build --all` where the shell is served (`/var/www/ui`; a test instance serves none)
([module-pages.ts](../../src/managers/exec/commands/mod/module-pages.ts)), which is how module pages
are rebuilt at every boot and after an install. A failed build is reported and does not fail the
setup. After an install, update or removal from Settings → Modules the shell reads the manifest and
`ui-nav` again (`reloadModuleUi`), so the entries come and go in the open page, and each router adds
a new module's routes on the first path that is its; a removed module's routes stay until the page
is reloaded, failing as a module that could not load.

**The module contract.** Modules import [`@ein/client`](../../src/client/mod.ts) and nothing else from core. That file is deliberately small, sized to what modules actually use rather than to what core exposes: `Command`, `CmdReturn` and `shq` in almost every bin, then a short tail. `ModuleSystemCore` carries `vfs` alone, because `cmd.sys.vfs` is the only thing any module touches — never the buffer, router or exec managers. Tests use [`@ein/testing`](../../src/client/testing.ts) the same way. `@ein/exec` is core's internals and is off-limits; [module-boundary.test.ts](../../src/modules/test/module-boundary.test.ts) asserts that, that no module reaches into `src/` by relative path, and that every specifier a module uses resolves by the module rule below. What the contract exports is only half of its size; the other half is what those exports import, because a module type-checks against — and a published package would carry — the whole graph. That graph was all of core (567 files, `pg` and `ssh2` among them) while the export list looked small: a spec type lived beside `Command`, the VFS interface imported registry barrels that re-export their PostgreSQL implementations, and `withHostPath`/`readComments` sat inside command files. They now come from leaf files (`exec/spec.ts`, each registry's `types.ts`, `lib/host-path`, `lib/comments`, `lib/media/raw.ts`) and the graph is ~60 files with no npm package; [contract-graph.test.ts](../../src/client/test/contract-graph.test.ts) holds it there. A type added to the contract should come from a file that imports nothing heavier than itself.

**The command API's other half: answers.** A command's arguments are declared (`CmdSpec`); what it writes under `JSON_OUTPUT=1` was declared nowhere, and the UI restated 21 answer shapes by hand. Core's answer types now live in [src/lib/api/](../../src/lib/api/) (alias `@ein/api`), a module's in its `lib/api.ts` exported as `./api`, or an area's `lib/<area>/api.ts` as `./<area>/api` (`@assistant/api`, `@archive/timeline/api`, `@archive/people/api`, `@archive/media/api`, `@archive/device/api`, `@archive/location/api`, `@archive/staging/api`). Both are **import-free** apart from other api files, so the browser and bins import them without type-checking core or the module. A command checks its answer where it writes it (`cmd.writeJSON(answer satisfies PersonTimeline)`), the UI imports the same type, and a UI that needs more declares a derivation of it (`SearchHit & { stackAlbumPath }`) rather than a copy. Binding found real drift the first time: fields the UI read that were no longer sent (`resource` for a pipeline step's `pool`/`kind`), fields sent but never declared, lists always sent but declared optional, `Date`s that arrive as strings. `Wire<T>` is a type as it crosses JSON, for answers whose server side holds dates.

**The contract has a version, and a test that keeps it honest.** `MODULE_API_VERSION` (src/modules/types.ts) is what each module's `coreApi` range is checked against at `mod setup`. [contract.test.ts](../../src/modules/test/contract.test.ts) compares the surface of `@ein/client`, `@ein/api`, `@ein/paths` and the shell's kit (`@ein/ui/components`, `/hooks`, `/lib`, `/signals`, `/theme`) — every exported symbol and a hash of its declaration from `deno doc --json`, doc comments and positions left out — with [src/client/contract.snapshot](../../src/client/contract.snapshot): an added symbol, or an interface or object type that only gained members, needs a compatible bump, a removed or changed one a breaking bump, and after bumping `deno task contract:snapshot` rewrites the snapshot. Below 1.0.0 the minor is the breaking part and the patch the compatible one, as in a caret range (`^0.1.0` takes 0.1.x only); from 1.0.0 the major and the minor.

**Shared node conventions.** A few layout names are shared across types and modules and so belong to core: `COVER_LINK_NAME` (`coverPhoto`, in `@ein/paths` because the browser reads it too) with `readCoverTarget`/`setCover` in `@ein/client`; `PREVIOUS_LINK_NAME` and `NEXT_LINK_NAME` (`previous`, `next`: an album's neighbours in a series), with `NON_MEMBER_LINK_NAMES`, the softlinks — these three — that are not members of the node they sit in; and `haversineMeters`. Everything else a node's layout means — `partners/`, `homes/`, `metadata/content`, `mediaStacks` — is the owning module's, exported from it rather than restated.

**Modules reach each other through exports.** A module's public interface is its `exports`: `./<name>` → a file in the module, imported elsewhere as `@<module>/<name>` (`@ems/client`, `@assistant/api`). A module made of several areas, as archive is, names an export after its area too — `./people/genealogy`, imported as `@archive/people/genealogy` — and its private aliases the same way (`@archive/media/face-cluster`). A dependent may import it only if it lists the provider in `dependencies`; nothing else in the provider — its other `lib/` files, its private aliases — is reachable. `imports` is what the module itself uses: private aliases into its own files, named after the module, and external packages; never a path into another module. The rule is one function, [resolve.ts](../../src/modules/resolve.ts) — own `imports`, then own `exports`, then a declared dependency's `exports`, then core's base map — shared by the loader, `deno task sync:modules` and the boundary test, so what type-checks, what runs and what the test allows cannot disagree. Running another module's commands is a dependency too: the boundary test reads command words out of `execute(...)` strings, pipeline `command:` lines and shell scripts and requires the owning module in `dependencies` (core's `search` asks every `search-*` command on PATH, which needs no dependency since core declares none); `dependencies` must form no cycle. `mod info <name>` lists a module's exports and the installed modules that depend on it. In TypeScript it also counts a string that starts with another module's hyphenated command name, since commands are often assembled in a variable before they run.

**Only a module's `#!ts` runs.** A `#!ts` command is imported into the EiN process and runs with all of its permissions — the process environment, the VFS as the administrator, the host's files — so the shell runs one only from under `MOD_PATH` (`/usr/modules`), which only the administrator writes: the deployment's modules linked there, or what `mod install` installed. The path is the constant, not the caller's `$MOD_PATH`. A `#!ts` file anywhere else, a user's home included, is refused with exit code 126 before it is imported, whoever runs it (ein/core#549); a user's own commands are bash scripts, which run under their own access.

**A bin resolves its own imports.** A `#!ts` command lives in the VFS, which Deno cannot import from, so it is staged as a copy and dynamically imported. The copy's specifiers would resolve against the import map the _process_ started with, which a module cannot add an entry to once it is installed, and there is no per-directory scope to hang one on because the copy is not in the module. [ts-command-loader.ts](../../src/managers/shell/ts-command-loader.ts) resolves them before staging, by the module rule: package targets become `jsr:`/`npm:` URLs, which Deno resolves with no import map at all, and file targets — the module's own, or a dependency's export read from the _installed_ dependency's manifest — become staged copies; a specifier the rule does not claim is left alone so core's base map still supplies `@ein/client`. Each file is rewritten with **its own module's** manifest whichever bin reached it, so a provider's private aliases are its own business, and a file stages to one copy per process whichever dependent got there first — `EmsError` is one class, so `instanceof` holds across modules. Relative imports are staged recursively; type-only imports are erased before the module runs, so they are left as written. The copies are `blob:` URLs in the process's memory, never files: nothing on disk can be read or replaced by another process or left behind for the next one. A copy is keyed by its VFS path and rewritten body, which embeds the URLs of its imports, so an unchanged file keeps its URL and Deno's module cache keeps hitting, while an edited lib gives every file that reaches it a new URL; it also means value imports cannot form a cycle, and one is refused with the files that form it. Importing a module that is not a dependency, or a path it does not export, fails to load with a message naming both. `mod cache` stages every bin and runs `deno cache` over the `jsr:`/`npm:`/`http(s):` specifiers the staging collected, so a first run does not resolve over the network inside a pipeline step.

**Type-checking resolves the same way.** Each module is a Deno workspace member (`"workspace": ["./modules/*"]`), so everything under `modules/<name>/` — bins, `lib/`, tests — resolves against `modules/<name>/deno.jsonc` before core's map. That file is generated from the module's `mod.json` by `deno task sync:modules` — the module rule projected into an import map, with each dependency's exports at `../<dep>/…`, the one place that assumes modules sit side by side — and kept honest by a step in [module-boundary.test.ts](../../src/modules/test/module-boundary.test.ts); the manifest is the single source. `deno task check:bins` strips the shebang beside each original, i.e. inside the member, so a bin now type-checks against its own manifest rather than against whatever alias core happened to carry. A member map only _adds_ to the root map, which is why this works where an earlier attempt at a generated standalone map per module did not: `@ein/client` drags core's whole graph in behind it, and re-resolving `pg`/`ssh2` under a synthetic map collapsed their npm types into a cascade of implicit-any errors from inside `src/`.

**Running a module command costs what it costs once.** Everything above happens per bin per process, not per invocation. Two caches sit in front of it, because a module command used to spend far more time being found and prepared than doing its work — measured quiescent in production, `person-faces` cost ~232 ms by name against ~64 ms by absolute path, and a bin that only prints a line cost ~115 ms. [command-lookup.ts](../../src/managers/shell/command-lookup.ts) resolves a name on `$PATH` with one point lookup per entry rather than `exists(dir)` plus a full `children(dir)` listing, and memoises the result — negative answers too, since a miss on an early entry is most of the work when the bin lives in the ninth. It is TTL-bounded (`COMMAND_LOOKUP_TTL_MS`, 5 s) rather than event-invalidated because `/usr/modules/<name>` are softlinks into filesystem mounts of the host's folders, so a bin added or removed on the host emits no VFS event to subscribe to; `mod setup`/`mod remove` clear it outright. [ts-command-loader.ts](../../src/managers/shell/ts-command-loader.ts) then keeps the imported `CmdFunction` against the bin's mtime and size, both of which come off the `vfs.get` the shell already does for the execute check — so a hit skips reading the bin, its `mod.json`, hashing and rewriting the graph, and the `import()`. Editing a **bin** still takes effect immediately; editing a module's `lib/` or `mod.json` takes effect when a bin that reaches it is next staged — when the bin changes, after `mod setup`, or in a new process — because the loaded command is kept against the bin's node alone.

**Contributions.** What a module adds to core's own machinery is found by a command's name, chosen by a setting, or declared in `mod.json`; never written into core. `mod setup` validates and registers it in memory ([src/lib/contributions/](../../src/lib/contributions/)), as it does settings; `mod remove` drops it; the test harness registers what its modules declare. The shapes are in [src/lib/contributions/types.ts](../../src/lib/contributions/types.ts) (the `ModuleManifest` fields); a type or name is owned by the first module to claim it.

- **Containers, by name.** `search --under` lists a directory's media itself, but a node type with rules of its own — an album's imported `files/` layout, its cover link, its photo stacks — has a command named `members-<type>` that lists its members: archive's `members-album`. Core looks the name up on `PATH` (memoised, dropped at `mod setup`/`mod remove`); there is no manifest field. The command answers `JSON_OUTPUT=1 members-<type> <path>` with a `ContainerListing` (`@ein/client`): every member's path, node id and member link, and for a folded member the one standing for it. Core only orders, filters and pages, so the rules and the data they read (the stacks manifest) stay in the module. Without the module a node of that type is listed as a directory again. Core's `members <path>` answers the same for any node, by the same rule.
- **Subjects, by name.** What media a subject has — the people in a picture, the location it was taken, the camera that took it — is the module's, which writes those links: a kind of subject has a command named `subject-<kind>` (archive's `subject-person`, `subject-location`, `subject-device`). `search --subject <kind>:<ref>` looks it up on `PATH` like a container command and runs `JSON_OUTPUT=1 subject-<kind> <ref>...`, which answers a `SubjectListing` (`@ein/client`): per ref the subject's path and either the ids of its media or one attr match the store answers by itself, or why the ref names nothing. Core orders, intersects, pages, counts and lays out; `--subject-name <kind>:<words>` finds the subjects through the `search-*` providers that answer the kind. `--group-by <type>` groups matches by the nearest ancestor of a node type, or, for a kind of subject, by the subjects each match has, which `subject-<kind> --of <file>` answers as a `SubjectsOf`. A kind is a file kind (`photo`, `video`, `audio`, `document`, by mimetype) or else a node's type — `person`, `location`, `album` — so `--kind`, `classify` and the subject commands need no list of the kinds modules bring. Core's search names no module, flag, attr or node type of archive's.
- **Search providers, by name.** Every `search-*` command on `PATH` is a candidate text provider for `search` (archive's `search-media`, `search-people`, …); there is no manifest field. Each answers `--kinds` with what it can return, whether it ranks `--within` a set and whether it ranks `--like` a picture, and one that does not answer with kinds is not a provider. Core's own commands keep out of the prefix (`facets`, `parse-search`): from 3d8c8784 to ein/core#447 providers were declared instead, because `search-facets`, sharing the prefix, ran its whole-corpus aggregates beside every search before the `--kinds` probe existed.
- **News, events and on this day, by name.** The home page's sections are core's `news`, `events` and `onthisday` ([src/managers/exec/commands/feeds/](../../src/managers/exec/commands/feeds/), the fan-out in [src/lib/feeds/](../../src/lib/feeds/)), and each asks every command on `PATH` named after it with a dash, at once; there is no manifest field. `news-<x> --limit N` answers what was added lately, newest first; `events-<x> --today YYYY-MM-DD --days-ahead A --days-past P --limit N` what falls in that window; `onthisday-<x> MM-DD --limit N` what is from that calendar day in earlier years, newest year first. Each answers a JSON list of its entries — `NewsEntry`, `EventEntry`, `OnThisDayEntry` in `@ein/api` without `source` (`Provided<T>`): a `title`, one line a terminal prints and a reader hears; a `route`, the module's own route that draws the entry, its query carrying what it draws; `path`, the node the entry is about, when there is one, for a reader of the answer such as the assistant, which links it; and what orders it (`at`, `date`, `year`; an event may be a `milestone`, a news entry may name its account, `by`, and an `icon`). Core merges the lists, marks each entry with its provider (`source`, the name after the dash), orders them, and cuts the whole list to the limit: newest first for news, newest year first for on this day, and for events milestones first and then the nearest, answered in date order. A provider that fails or answers no list is named on stderr and skipped, an entry missing its shape is left out, and the command fails only when every provider did. Archive provides `news-albums`, `events-anniversaries` and `onthisday-media`. Core's own commands keep out of the three prefixes.
- **The command finder, the search parser, a language model and a text embedder, by setting.** `docs find` and `parse-search` ask the command the core settings `CFG_COMMAND_FINDER` and `CFG_SEARCH_PARSER` name; empty is core's own behaviour (a word match over command names and descriptions; the words searched as they are). Archive sets the parser (`archive-parse`) and the assistant the finder (`assistant-commands`), each in its own `etc/config`, linked as `/etc/config.d/<module>` (see Configuration in [architecture.md](../architecture.md)), so the search box and the docs name no module. `CFG_LANGUAGE_MODEL` and `CFG_TEXT_EMBEDDER` are read by no core code: they name a command a module runs when it needs a language model or text vectors (answering `LanguageModelReply` and `TextEmbedding` in `@ein/api`), so the module that has one sets it and the one that needs one names neither — archive's parser asks the assistant's `llm-chat` this way. Before ein/core#447 the first two were the manifest fields `commandFinder` and `searchParser`.
- **Completion, by node type.** A node type in `nodeTypes` with a `root` is what an `@` completes to, by its type: `{ "type": "location", …, "root": "/archive/locations" }`. `completion-entity` lists each such root. Before ein/core#447 this was the manifest field `complete`.
- `roots` — the archive roots the module's content lives under: archive `/archive/albums`, `/archive/people`, `/archive/locations` and `/archive/devices`, core `/archive/tags` (labels are core's). `mod setup` creates a missing one, the admin's and the `users` group's, mode 775, and leaves an existing one as it is; nothing removes one, since it holds the content. Boot makes only `/archive` itself (`02_archive.sh`), so an instance without archive has none of its roots. Each is named by its owner: archive's in `@archive/paths`, the label tree as `TAGS_ROOT` in `@ein/paths`; [roots.test.ts](../../src/modules/test/roots.test.ts) refuses a root two modules declare.
- `indexes` — an index on the module's attrs for a query its data is asked: `{ "name": "taken_utc", "on": ["takenAtUtc"], "partial"?: "…" }`, or with `"using": "trigram"` a trigram index over one attr's text, for `contains`, or with `"using": "statistics"` no index, only the planner's statistics on one attr. `mod setup` has the store create `<attrs table>_<name>_idx` over each attr's sort expression and the node id (`NodeVFS.ensureAttrIndexes`, admin only; a store without indexes ignores it). The ten module-attr indexes the PostgreSQL store used to create at init are declared this way by media, people and device under the names they had, so an existing database rebuilds nothing. `mod remove` leaves an index in place: dropping it would cost a rebuild on the next setup, and an unused index costs only writes.

**Describing what a module brings.** A command describes itself (`CmdSpec`) and a setting where it is registered (`config.options`), but a node type is a free-form string and an environment variable is read wherever it is needed, so neither has a location of its own. A module describes its node types in `nodeTypes` (`{ type, label, category, description, root? }`) and the environment variables it reads, other than its settings, in `environment` (`{ key, kind, description, default? }`), the same shapes core uses for its own ([src/lib/reference/](../../src/lib/reference/)). Apart from completion (above), nothing registers them: `docs node-types` and `docs env` read the installed manifests at each call, so the documentation follows whatever is in `/usr/modules`. A malformed entry is a warning at `mod setup` (`checkReference`), like a malformed setting.

**Validation.** `mod setup` checks `coreApi` against `MODULE_API_VERSION`, every entry in `dependencies`, that `exports` and `imports` stay inside the module and every export exists, that the module is installed under its own name, and the shape and containment of `ui.routes` before touching anything, and refuses rather than half-installing — setup puts bins on PATH and starts services the moment it runs. `ui-build` additionally verifies that the route directory holds a page and that the pages import nothing they may not.

## Installing a module from its repository

`mod install <name | https://host/owner/module-name>[@ref]`
([mod-install.ts](../../src/managers/exec/commands/mod/mod-install.ts)) fetches a module and sets
it up. The image has no git, so the fetching is plain HTTP that GitHub, Forgejo and Gitea all
answer ([forge.ts](../../src/modules/forge.ts)): the ref — a branch, a tag, a commit, or the default
branch when none is given — is resolved from git's own ref advertisement
(`<repository>.git/info/refs?service=git-upload-pack`), a commit's id cut short, which no
advertisement holds, from the forge's API, and the tree at that commit is the forge's
`/archive/<commit>.tar.gz`. It is unpacked through the VFS into `.staging-<id>` beside the
installed modules ([install.ts](../../src/modules/install.ts)), with each file's mode, so a bin
stays executable, then checked, renamed into place and linked as `/usr/modules/<name>` →
`/var/lib/modules/<name>`. A module replaced is renamed aside first and removed after, so the name
always holds one whole tree. `.install.json` in the module records the repository, the ref, the
commit and when; `mod list` answers it as `installed`, and `system-info` takes its commit.

**Where it lives.** `/var/lib/modules` is a filesystem mount, read-write, of the folder
`MODULE_INSTALL_PATH` names (`/modules-installed` in the container). A deployment mounts a folder
of the host there — `make container-run` does, `MODULE_INSTALL_PATH ?= ./modules-installed` — so
the installs outlive the container: a new image, a `podman run --replace`, even a new database,
since boot links whatever is in the folder at every start. Without the mount the folder is the
container's own and the installs go with it. Hidden entries are not modules, so a staging tree an
interrupted install left is never linked.

**At boot.** A deployment that wants modules without anyone installing them names them in
`INSTALL_MODULES` (names or addresses, separated by spaces; `make container-run INSTALL_MODULES=…`).
Boot runs `mod install --missing --no-setup` with them after linking: `--missing` leaves a module
installed already as it is, at whatever version, without asking its forge, so a boot is no update,
and `--no-setup` leaves setting up to the `mod setup --all` after it and starting services to the
last boot script, which runs once this boot's settings are written. A forge that does not answer
costs that module, not the boot.

**Where to look.** `CFG_MODULE_SOURCES` lists organisations on GitHub, Forgejo or Gitea, in order
(`https://github.com/einhq` by default); each repository named `module-<name>` there is a
published module. `mod install <name>` takes the first source that has `module-<name>`.
`mod search [words]` ([mod-search.ts](../../src/managers/exec/commands/mod/mod-search.ts)) lists
them all, asking every source at once, with each default branch's `mod.json` version and
`coreApi` and its commit, and names a source that does not answer; the Modules tab of the
settings page shows the same with Install and Update. `CFG_MODULE_SOURCES_KEY` holds tokens for
private sources as `host=token`, and a token is sent to its own host only, so an address on a
command line cannot carry one elsewhere.

**Before anything is replaced** a module must pass what `mod setup` would refuse it for: `coreApi`
against this core, its exports and its pages. It must be no deployment's: a name the deployment
mounts at `DEV_MODULES_PATH` runs from there, `mod install` refuses it, and boot says so when the
folder holds one too. Something else at `/usr/modules/<name>` — not a link into the folder, or a
dangling one — is refused as well.

**Dependencies.** One that is not installed is installed first, from the module's own
organisation (`module-<dependency>` beside it) and else from the sources, and must then satisfy
the range; one installed at a version outside the range refuses the install and says
`mod install <dependency>` updates it.

**Updates and dependents.** `mod install` of an installed module is its update; the same commit
again is left alone (`--force` fetches it anyway). A module installed at a commit, recorded with
the commit's whole id as its ref, stays there: its panel's Update, which installs the recorded ref
again, is not offered for it, and `mod install <name>` without a ref moves it to the default
branch. Every installed module that depends on it must
accept the new version, or nothing changes; `--force` updates anyway. After the swap the module is
set up and its services restarted — on a first install, started — and every module depending on
an updated one, however indirectly, is set up again and its running services restarted, so none
keeps running the code that was replaced. The modules' pages are rebuilt once at the end.

**Removing.** `mod remove` of an installed module removes its tree from the folder with its link.
One the deployment provides loses only its link, and boot links it again.
