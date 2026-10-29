# The module manifest (`mod.json`)

Part of the [module system](modules.md). That page explains how modules work; this one is the
reference for every field a module's `mod.json` can carry: what it is, what it looks like, and
what reads it. The type is `ModuleManifest` in
[src/modules/types.ts](../../src/modules/types.ts); `mod setup` validates a manifest
([validate.ts](../../src/modules/validate.ts),
[contributions/registry.ts](../../src/lib/contributions/registry.ts)) and refuses one that is
wrong, naming each bad entry.

Nothing in a manifest is code. Everything a module _does_ is in its folders (`bin/`, `services/`,
`pipelines/`, `ui/`, `docs/`); the manifest says who the module is, what it shares, and what it
adds to the machinery core already has.

## At a glance

| Field               | Group     | In one line                                                                               | Acts at                   |
| ------------------- | --------- | ----------------------------------------------------------------------------------------- | ------------------------- |
| `name`              | identity  | the module's name; also its alias prefix (`@archive/…`)                                   | always                    |
| `version`           | identity  | its semver version, which dependents' ranges are checked against                          | `mod setup`               |
| `description`       | identity  | one sentence for `mod list` and the docs                                                  | display                   |
| `author`, `license` | identity  | free text                                                                                 | display                   |
| `coreApi`           | identity  | the range of core's module contract it is written against                                 | `mod setup`               |
| `exports`           | code      | the files other modules may import                                                        | load / check              |
| `imports`           | code      | its own private aliases and external packages                                             | load / check              |
| `dependencies`      | code      | modules it needs: their exports and commands                                              | `mod setup`               |
| `config.options`    | settings  | the settings it owns, shown on the settings page                                          | `mod setup`               |
| `environment`       | reference | environment variables it reads, documented                                                | docs                      |
| `nodeTypes`         | reference | the node types it defines, documented; what an `@` completes to and the Search page finds | docs, runtime, `ui-build` |
| `roots`             | archive   | directories under `/archive` its content lives in                                         | `mod setup`               |
| `indexes`           | archive   | database indexes on node attrs it queries                                                 | `mod setup`               |
| `ui.routes`         | browser   | its pages, by route                                                                       | `ui-build`                |
| `ui.open`           | browser   | which route opens a node of a type                                                        | `ui-build`                |

"Acts at" says when the field matters. `mod setup` runs for every module at each boot, in
dependency order, so a `mod setup` field takes effect on the next deploy. "Runtime" means core
looks it up while running, from what `mod setup` registered. "load / check" means it is read when
a module's TypeScript is loaded, and by `deno task check` through the generated `deno.jsonc`.

The rest of this page goes through them in that order.

## Identity

### `name` (required)

The module's name: lower case, digits and hyphens. It is the directory under `/usr/modules/`,
the owner shown beside its settings, node types and commands, and the prefix of its aliases —
everything archive shares is imported as `@archive/…`.

### `version` (required)

Semver. Dependents name a range (`"archive": "^0.3.0"`), and `mod setup` refuses a dependent
whose range the installed version does not satisfy. As in a caret range, below 1.0.0 the minor
moves when something a dependent uses changes or goes, and the patch for anything else; from
1.0.0 the major and the minor. Each released version is tagged `v<version>` in the module's
repository, which is what `mod install <name>@v<version>` installs.

### `description`, `author`, `license`

Free text. `description` is shown by `mod list`, `mod info`, the settings page's Modules tab and
the documentation's modules page. Write it as what the module _is_ for a reader
("The archive: people and their family tree, locations and tracks, …").

### `coreApi`

The range of core's module contract the module is written against, as a semver range:
`"^0.1.0"`. Core's side is `MODULE_API_VERSION` in [types.ts](../../src/modules/types.ts).

The contract is what a module may use from core: `@ein/client`, `@ein/api`, `@ein/paths` and the
shell's kit `@ein/ui/*`. `src/client/contract.snapshot` lists every symbol in it, and a test fails
when the contract changes without the version and the snapshot changing with it: a compatible
bump for additions, a breaking one for anything removed or changed — and on a breaking bump, every
module's `coreApi` too. Below 1.0.0 the minor is the breaking part and the patch the compatible one.
A module whose range the core does not satisfy is refused at `mod setup`; an absent `coreApi` is
accepted with a warning.

## Code: what a module shares and uses

These four decide what a module's TypeScript may import and which other modules' commands it may
run. One function, [resolve.ts](../../src/modules/resolve.ts), applies the rule for the loader
that runs `#!ts` bins, for `deno task sync:modules` (which writes the module's `deno.jsonc` from
these fields), and for the boundary test, so what type-checks, what runs and what the test
allows are the same thing. Never edit a module's `deno.jsonc`; edit `mod.json` and run
`deno task sync:modules`.

### `exports`

The module's public interface: `"./<name>": "./<file>"`. Another module imports the file as
`@<module>/<name>`, and only if it lists this module in `dependencies`. Nothing else in the module
is reachable from outside it.

```json
"exports": {
  "./api": "./lib/api.ts",
  "./people/genealogy": "./lib/people/genealogy.ts",
  "./people/types": "./types/people/mod.ts"
}
```

A module made of areas, as archive is, names an export after its area: `./people/genealogy` is
imported as `@archive/people/genealogy`. An export is also usable inside the module itself under
the same alias. Conventions:

- `./api` — the types of what the module's commands answer under `JSON_OUTPUT=1`, imported by its
  own pages and by other modules; `./<area>/api` for an area's. These files import nothing but
  other API files, so a browser page can import them without type-checking the module.
- `./<area>/types` — the area's node attr types (`types/<area>/mod.ts`).
- `./testing` — a test stand-in other modules' tests may use (ems's fake media service).

### `imports`

What the module's own code uses: private aliases into its own files, and external packages.

```json
"imports": {
  "@archive/media/face-match": "./lib/media/face-match.ts",
  "@std/path": "jsr:@std/path@^1.1.3",
  "pg": "npm:pg@^8.16.3"
}
```

A private alias is named after the module, `@<module>/…` (or `@<module>/<area>/…`), like its
exports; it is private because it is not in `exports`. A target is a path inside the module, or
a `jsr:`, `npm:` or `http(s):` package. Never a path into another module — that is what
`dependencies` and the other module's `exports` are for. Core's own map (`@ein/client`,
`@ein/paths` and the rest) is always available and not restated here.

An alias reaches _below_ itself only when it ends in `/` or is a package: `@archive/timeline`
mapping to a file says nothing about `@archive/timeline/facets`, which needs its own entry. This
is Deno's rule too.

### `dependencies`

Other modules this one needs, as name → semver range: `"dependencies": { "ems": "^0.2.0" }`. A
dependency is

- checked at `mod setup`: it must be installed, at a version in the range;
- set up first: modules are set up in dependency order, and the graph must have no cycle;
- the only way to import another module's `exports`;
- required to run another module's commands. The boundary test reads command names out of
  `execute(…)` strings, pipeline `command:` lines and shell scripts, and fails a call to a
  module not listed.

## Settings and reference

### `config.options`

The settings the module owns. `mod setup` adds them to the live settings table and `mod remove`
drops them, so they appear on the settings page and in `config` without core knowing them. The
values are never in the manifest: they live in `/etc/config` (system) and `~/.config` (user),
and every shell sees them as environment variables. A module that wants a setting — its own or
core's — to have a value of its choosing writes it in its `etc/config` (below).

```json
{
  "key": "CFG_FACE_ATTACH_THRESHOLD",
  "scope": "system",
  "type": "number",
  "default": "0.55",
  "label": "Face match threshold",
  "description": "How similar two faces must be before one is attached to a known person. …",
  "group": "Faces",
  "restarts": ["models"]
}
```

| Key           | Meaning                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `key`         | the environment variable. `CFG_…` for system settings, `CFG_USER_…` for per-user ones                                   |
| `scope`       | `system` (one value, the administrator sets it) or `user` (each user their own)                                         |
| `type`        | `string`, `number`, `boolean`, `select`, `mode`, `user`, `group` or `secret`: the control and what `config set` accepts |
| `choices`     | the allowed values, for `select`                                                                                        |
| `default`     | what applies when nothing is set. Always a string, never written to the file                                            |
| `label`       | the setting's name on the settings page                                                                                 |
| `description` | what it does, for the reader of the settings page. Say what changes, not how it is implemented                          |
| `group`       | the section of the settings page it is listed under                                                                     |
| `restarts`    | services that read it at start, restarted when it changes                                                               |
| `restartNote` | shown instead of restarting, for a service that cannot be bounced from a page                                           |
| `emptyMeans`  | what an empty value means, when empty is a choice rather than "unset"                                                   |

A `secret` is a key to another service. It is named `CFG_…_KEY`, a name only a secret may have,
and has no default. No shell sees it, and the settings say only whether it is set; the module's
client reads it with `serviceKey` when it makes a request (Configuration in
[architecture.md](../architecture.md)).

### `environment`

Environment variables the module reads that are _not_ its settings, documented for `docs env`
and the documentation's environment page:

```json
{ "key": "NOMINATIM_SEARCH_URL", "kind": "option", "default": "https://nominatim.openstreetmap.org/search", "description": "…" }
```

`kind` says how the variable reaches its reader: `option` (nobody sets it; export it in a shell to
change a command's behaviour), `deployment`, `session`, `path`, `system` or `pipeline` — see
`EnvVarKind` in [reference/types.ts](../../src/lib/reference/types.ts). A module almost always
means `option`.

### `nodeTypes`

The node types the module defines, described for `docs node-types` and the documentation's
node-type page. Purely descriptive: a node type exists as soon as a node carries it, and one used
but described nowhere is still listed, with its count and no description.

```json
{ "type": "album", "label": "Album", "category": "content", "description": "A collection of photos and videos that behaves as a directory. …" }
```

`category` is `content` (what the archive holds), `structure` (what organises it) or `system`.

A type whose nodes live directly under one folder names it as `root`, and that makes it something
an `@` mention in the search box completes to, by its type:

```json
{ "type": "location", "label": "Location", "category": "content", "root": "/archive/locations", "description": "…" }
```

Typing `@ann` lists the names of nodes of every such type directly under its root that match.
`mod setup` registers the types with a root and `mod remove` drops them
([contributions/registry.ts](../../src/lib/contributions/registry.ts)); a type is the first
module's to claim it. `completion-entity` answers, listing each type's names and caching them for
a few seconds, since it runs on every keystroke.

A type with a root may also be `searchable`: the Search page finds its nodes and offers it as a
choice of what to show, by its `plural` (the label with an `s` when there is none). `ui-build`
carries these into the UI manifest as the module's `search`, in the order of `nodeTypes`, so
without the module the page neither searches for its types nor names them; with fewer than two
the choice is left out. The kind must be one the `search` command takes as `--kind`.

```json
{ "type": "person", "label": "Person", "category": "content", "root": "/archive/people", "searchable": true, "plural": "People", "description": "…" }
```

## The archive

### `roots`

The directories directly under `/archive` the module's content lives in:
`["/archive/people", "/archive/albums", …]`. `mod setup` creates a missing one, owned by the
administrator and the users group, mode 775; nothing ever removes one, so uninstalling a module
does not delete content. No root may be declared by two modules. The module names its roots for
its own code and its dependents (archive's `@archive/paths`).

### `indexes`

Database indexes on node attrs, for the queries the module's data is asked. `mod setup` creates
each one if it is missing.

```json
{ "name": "device_taken_utc", "on": ["devicePath", "takenAtUtc"], "partial": "devicePath" }
```

| Key         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`      | lower case, digits and `_`; the index is `<attrs table>_<name>_idx`                                                                                                                                                                                                                                                                                                                                                                                               |
| `on`        | the attrs, in order; a dotted path reaches into a nested attr (`relation.from`)                                                                                                                                                                                                                                                                                                                                                                                   |
| `partial`   | only nodes where this attr is set are indexed — small and cheap for an attr few nodes have                                                                                                                                                                                                                                                                                                                                                                        |
| `collation` | `bytes` (the default) or a language (`en`, `sv`): the order the attrs are held in, which must be the order a query asks for (`NodeQueryOrder.collation`) to use it                                                                                                                                                                                                                                                                                                |
| `using`     | `trigram`: a trigram index over one attr's text instead, with no collation, which serves `contains` (a substring anywhere in the text) and no order; the store also keeps statistics on the attr, so a query for an attr few rows carry reads the index. `statistics`: no index, only those statistics on one attr, with no collation or partial, for a condition no index serves that the planner would otherwise misjudge (`missing` on an attr few rows carry) |

## The browser

### `ui.routes`

The module's pages: each route path, with the file that draws it, relative to the module root.

```json
"ui": { "routes": { "/devices": "ui/device/pages/devices.tsx", "/devices/:id": "ui/device/pages/device.tsx" } }
```

A path is absolute below `/`, of literal and `:param` segments; `/` itself is the shell's home
page. The page's default export is its component. Core's `ui-build` bundles the pages
inside the running EiN whenever the modules change, and the shell loads the bundle the first time
one of the routes is opened. A path two modules give is refused. How the shell shows a route — as
the page, in a dialog, in the drawer or full screen — is the navigation's choice (`ui/nav.json`,
below), not the route's. [Module system](modules.md#module-system) has the details.

### `ui.open`

Which route opens a node of a type, so the shell can link nodes it finds but does not know —
search results, completions, the node explorer's Open:

```json
"open": { "person": "/people/{name}", "album": "/albums/{path}", "track": "/devices/{parent}?tab=track" }
```

`{name}` is the node's last path segment, `{parent}` the one before it and `{path}` its whole path,
all URI-encoded. A type no
installed module names is not a link.

## Not in the manifest: the module's folders

Some of what a module brings is found by where it is, not by a field:

| Folder                    | What `mod setup` does with it                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `bin/`                    | added to every shell's `PATH`; each file is a command (a shell script or `#!ts` TypeScript)           |
| `services/<name>/`        | registered as a service: `start.sh` and `config.json` (`description`, `restartPolicy`, …)             |
| `pipelines/*.yaml`        | registered as pipeline definitions                                                                    |
| `ui/nav.json`             | linked as `/etc/ui/nav.d/<module>.json`: its sidebar and top-bar entries, each opening a route        |
| `etc/config`              | linked as `/etc/config.d/<module>`: the module's own choice of settings, sourced before `/etc/config` |
| `etc/<x>.d/`              | linked as `/etc/<x>.d/<module>`: what it gives whichever module reads `/etc/<x>.d/*` (`assistant.d`)  |
| `etc/` (the rest)         | copied into `/etc` when not already there, never overwritten                                          |
| `docs/`                   | linked under `/usr/docs/modules/<name>`: the module's user documentation                              |
| `lib/`, `types/`, `test/` | ordinary source, reached through `imports` and `exports`                                              |
| `deno.jsonc`              | generated from `mod.json` by `deno task sync:modules`; never edited                                   |

A module's own figures on the system dashboard need no field either: the module samples them in a
service of its own into a metrics log, reads them back with a command, and draws them in a
`system.overview` panel from its `ui/nav.json`. ems's GPU tiles are made that way (`gpu-sampler`,
`ems-gpu`, `ui/pages/gpu.tsx`).

A node type with members of its own rules needs no field either. `search --under <node>` and core's
`members <node>` run `members-<type>` for the node's type when a command of that name is on `PATH`,
and list the node as a directory otherwise. Archive's `members-album` is why an album's imported
`files/` layout, linked members and stacks of similar photos come out right. It answers
`JSON_OUTPUT=1 members-<type> <path>` with a `ContainerListing` (`@ein/client`).

Nor does a kind of subject. `search --subject <kind>:<ref>` runs `subject-<kind>` when a command of
that name is on `PATH`: `JSON_OUTPUT=1 subject-<kind> <ref>...` answers a `SubjectListing`
(`@ein/client`) — per ref, the subject's path and either `ids` (the media files it has) or a `match`
(`{ attr, value }`, an equality the store can page and count by itself), or an `error` saying what
to try instead. `search --group-by <kind>` asks the other way round: `JSON_OUTPUT=1 subject-<kind>
--of <file>`, the file holding the matching media's ids as a JSON array, answers a `SubjectsOf` —
each subject once, with its name unless nobody has named it, and per media id the subjects it has.
Archive's `subject-person`, `subject-location` and `subject-device` are why a person's faces and
tags, a location's links and a camera's `devicePath` find their media and are counted over a
search's matches, though core's `search` names none of them.

Nor does a search provider. Every `search-*` command on `PATH` is a candidate (archive's
`search-people`, `search-media`, …). `search` asks each once `<command> --kinds`; one answering
`{ "kinds": [...], "within": true?, "notWithin": true?, "like": true? }` — what it can return
(`person`, `photo`, `album`, …), whether it can rank inside a given set of files, whether it can
leave out what lies under a directory, and whether it can rank by a picture — is a provider,
anything else is left out. A search then asks the providers whose kinds it wants
`<command> '<words>' -l <limit>` (or, for `search --like`, those answering `like`,
`<command> --like <path> -l <limit>`), with `--not-within <dir>` once per unlisted tree to those
answering `notWithin`; each answers
a `SearchProviderResponse` (`@ein/api`): one row per hit and channel — what the hit was found by,
`name`, `picture`, `transcript` and so on — with a score on that channel's own scale and at most
`<limit>` rows per channel. `search` ranks each channel across the providers and fuses the ranks.
The prefix is therefore reserved: a command named
`search-*` that is not a provider should answer `--kinds` with an error.

Nor do the home page's sections. `news`, `events` and `onthisday` each ask every command on `PATH`
named after them with a dash, under `JSON_OUTPUT=1`: `news-<x> --limit <n>`,
`events-<x> --today <YYYY-MM-DD> --days-ahead <a> --days-past <p> --limit <n>` and
`onthisday-<x> <MM-DD> --limit <n>`. Each answers a list of entries, `Provided<NewsEntry>`,
`Provided<EventEntry>` or `Provided<OnThisDayEntry>` (`@ein/api`): a `title`, the `route` of the
module's own page that draws the entry with what it draws in its query, the `path` of the node it
is about when there is one, and what orders it. Core
merges, orders and cuts the whole list, and the home page draws each entry at its route. A provider
that fails is named and skipped. These prefixes are reserved too: a command so named is asked.

Nor does choosing the command for a job only one may do. The search box's reading of words and
`docs find` each ask the command a core setting names: `CFG_SEARCH_PARSER`
(`<command> [--rules] <words>`, answering a `SearchParse`) and `CFG_COMMAND_FINDER`
(`<command> find <words> --limit <n>`, answering a `CommandFind`), both in `@ein/api`. Empty, the
default, is core's own behaviour. A module sets them in its `etc/config`, a shell file of
`export KEY='value'` lines that `mod setup` links as `/etc/config.d/<module>` and `mod remove`
unlinks; archive's is

```sh
export CFG_SEARCH_PARSER='archive-parse'
```

and the assistant's

```sh
export CFG_LANGUAGE_MODEL='llm-chat'
export CFG_COMMAND_FINDER='assistant-commands'
```

It is sourced before the administrator's `/etc/config`, so a value set on the settings page wins,
and the settings page shows a value that came from it as the module's.
