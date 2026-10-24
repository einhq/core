# About

EiN (_Everything Is a Node_) is a specialized Content Management System. The intention is to have a tool where lives can be documented. EiN enables storing and organizing of photos, written texts, events etc.
All items in the database can be connected to people, things and should be positioned geographically as well as in time.

The aim is to visualize all this information in a way that is easy to understand and use. Photos and other content should always be accessible and not just stored away in a box somewhere where they are never looked at. By recording content from lives in a family a repository with the family history will be created where everyone in the family can view and add to the content.

Data is stored and represented by nodes in a virtual filesystem which are stored in a database. Nodes are things like locations, persons, albums, cameras etc. Things should, if applicable, always have a position in both space and time. Properties that represent an item are “who”, “with”, “when” and “where”. Examples of items are photos, logbook entries, events such as birth, death etc.

The main use case is for a family to share their common history and lives, a repository for pictures and a family tree. But EiN could also be used only as an online photo album if so desired.

EiN is written in TypeScript on Deno, with PostgreSQL (TimescaleDB and pgvector) as its database
and a React interface in the browser. Media analysis — renditions, faces, voices, text — is done by
EMS, a media service of its own (`ein/ems`), and the chat assistant talks to any
OpenAI-compatible language model.

## Development

```bash
make help              # every target
deno task dev          # the primary instance, http://localhost:8080 and SSH on port 2222
deno task test         # the fast in-memory tests
```

PostgreSQL is a service of its own (`ein/db`); `POSTGRES_URL` defaults to
`postgres://ein:ein@localhost:5432/ein`. The image is Deno and nothing else: `make container-build` and `make container-run`, with EMS reached at `CFG_EMS_URL`.

Modules are repositories of their own (`ein/module-<name>`), published as
`https://github.com/einhq/module-<name>`. A running EiN installs them itself, into the folder
`make container-run` mounts as `MODULE_INSTALL_PATH` (`./modules-installed` unless set), which
keeps them when the container is replaced:

```bash
mod search             # in EiN's shell: the published modules
mod install archive    # with what it needs; Settings → Modules does the same
```

To develop one against this core, check it out as `modules/<name>` instead: those are mounted as
the deployment's own modules and win over an installed one of the same name. Core names no
module; which ones a deployment runs is the deployment's choice.
