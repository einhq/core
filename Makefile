.PHONY: help container-build container-run container-stop container-logs container-shell \
       dev dev-watch bundle-ui bundle-ui-watch test test-pg container-test check lint

# Config
#
# Storage tier roots. Both MUST be host directories bind-mounted into the container: a tier
# root that is not mounted lands in the container's writable layer, which lives in podman's
# graphroot rather than on the data disk, and is destroyed by the next `podman run --replace`.
#
#   disk     originals and frozen versions/ — the durable tier (docs/architecture.md calls
#            for a NAS over NFS in production)
#   volatile renditions: thumbnails, web transcodes, face crops. Regenerable, and separated
#            so it can be wiped or moved to faster storage without touching originals.
#
# They may point at the same directory (volatile falls back to FILE_ROOT_PATH when unset),
# but splitting them means `du` tells you what is precious and what is cache. Changing
# VOLATILE_FILE_ROOT_PATH on an existing deployment strands already-written renditions.
FILE_ROOT_PATH          ?= ./files
VOLATILE_FILE_ROOT_PATH ?= ./files-volatile
# Scratch for staged writes. Defaults to the container's /tmp when unset, i.e. the writable
# layer — fine for small files, but it is on the wrong disk and vanishes on --replace.
FILE_TMP_PATH           ?= ./files-tmp
# Timezone the container renders and buckets in. Every timestamp is *stored* as an instant,
# so this changes what is displayed and which year a birthtime aggregate counts a file
# towards — not what any of it means. It reaches PostgreSQL's session TimeZone too, via
# SYSTEM_TIME_ZONE in src/lib/datetime/timezone.ts; the two must agree or the in-memory and
# pg aggregates split on the year boundary.
#
# Defaults to the host's own zone so a container and a bare `deno task dev` on the same
# machine read the same clock. The image has none of its own, so leaving this unset ran
# every deployment in UTC — in production that put the log two hours behind the `podman logs`
# around it. A host profile pins it rather than depending on the remote's configuration.
TZ               ?= $(shell timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)
# Passed in as CFG_HTTP_PORT / CFG_SSH_PORT, which the service start scripts read. With
# --network=host these land straight on the host, so there is nothing to publish. A running
# instance changes them from the settings page instead; these are only the starting values.
HTTP_PORT        ?= 8080
SSH_PORT         ?= 2222
# PostgreSQL is a service of its own, run beside this container; EiN only needs to reach it.
POSTGRES_URL     ?= postgres://ein:ein@localhost:5432/ein
# The image that gets built and run, and the name of the running container. They default to
# the same word and were the same variable until a host had to carry two deployments at once.
# Splitting them is what lets a second deployment reuse an already-built 35GB image instead of
# rebuilding it: set CONTAINER_NAME per deployment, leave IMAGE_NAME shared. Note that a
# rebuild then retags the image both deployments name — running containers keep the layers
# they started with, so the other one only moves to the new code when it is next restarted.
IMAGE_NAME       ?= ein
CONTAINER_NAME   ?= ein
# Bring the container back by itself after a crash. Measured 2026-09-05 in production: the cgroup hit
# its cap, the kernel killed deno, and with no policy the whole deployment -- including a detached
# import sweep -- simply stayed down until a human noticed, 46 minutes later.
#
# `on-failure` and not `always`: a deliberate `make container-stop` is a clean exit and must stay
# stopped. The retry cap stops a container that
# OOMs on every start from looping forever -- after it, the deployment is down and honest about it.
CONTAINER_RESTART ?= on-failure:5
# Give PID 1 time to stop services and return pool leases. Podman's default is
# 10 seconds, shorter than a parallel service teardown under load; after it,
# SIGKILL makes a planned restart indistinguishable from a crash.
CONTAINER_STOP_TIMEOUT ?= 60
# Host directory mounted at /old, whose files/ subdirectory holds the legacy originals the
# importer reads (import-files --old-files, default /old/files). The disk-tier symlinks point
# at /old/files/<diskfilename> — a CONTAINER path — so any deployment that must resolve them
# has to mount the same bytes here. Defaults to the checkout's own old/, which in production is a
# bind mount of the archive; a second checkout points straight at the bind source instead and
# needs no mount of its own.
OLD_PATH         ?= $(PWD)/old
# CONTAINER_MEMORY caps the Deno process; services the modules use run in containers of their own.
# Keep it a wall the container hits fast and visibly — see the swap note below.
CONTAINER_MEMORY ?= 6g
# Total memory+swap for the container. Equal to CONTAINER_MEMORY means the container gets no
# swap at all, which is deliberate.
#
# podman's default when this is unset is *twice* --memory, so in production a 10g cap silently became
# 10g RAM + 10g swap — the host's entire swap, on a box with 15 GiB of RAM. A leaking model
# server (in this image, then) took hours to die instead of minutes, and spent them thrashing: 2.5M pages
# swapped out, 8.3M direct-reclaim scans and 37k major faults in one episode, which is the
# whole desktop and postgres going unresponsive, not just EiN. Swap buys nothing here —
# the models' working set is resident by design — so the cap should be a wall the container
# hits fast and visibly, not a cliff it slides down.
CONTAINER_MEMORY_SWAP ?= $(CONTAINER_MEMORY)
# The deployment's settings, as KEY=value lines (podman's --env-file): every CFG_* that core and
# its modules read, beyond the ports above. Unset, each setting keeps its default.
ENV_FILE         ?=
# The modules the deployment runs: a directory with one module checkout per subdirectory, mounted
# read-only at /modules-dev, which boot links into /usr/modules and sets up.
MODULES_PATH     ?= $(PWD)/modules
# Where `mod install` puts the modules it fetches from their repositories, mounted read-write at
# /modules-installed. A host directory, like the storage tiers: inside the container the installs
# would go with the next `podman run --replace`, a new image included. A module also in
# MODULES_PATH runs from there.
MODULE_INSTALL_PATH ?= ./modules-installed
# Modules boot installs into MODULE_INSTALL_PATH when they are not there, by name or repository
# address, separated by spaces: `INSTALL_MODULES='archive assistant'`. One installed already is
# left as it is; `mod install` or the settings page updates it.
INSTALL_MODULES  ?=
# The guide the Docs page shows: a checkout of the site (ein/einhq.github.io), mounted read-only
# at /guide-dev, so its pages read as written. Empty keeps the copy the image bundled.
GUIDE_PATH       ?=
# Extra flags for the `deno run` that starts the server. Empty leaves the image's own CMD
# alone; setting it overrides the command, so the flags land between `deno run -A` and the
# entrypoint. Meant for diagnosis, one run at a time:
#
#   DENO_ARGS='--inspect=127.0.0.1:9229' make container-run   # heap snapshots over CDP
#   DENO_ARGS='--v8-flags=--max-old-space-size=4096' ...      # raise the ~2GB V8 heap limit
#
# --inspect binds inside the container, and --network=host puts it on the host's loopback,
# so it is not reachable off the box. Keep it that way: the inspector evaluates arbitrary JS.
DENO_ARGS        ?=
# Log level for the server (`LOG_LEVEL=DEBUG`) and per-logger overrides
# (`LOG_MODULES=tty:DEBUG,ssh-server:DEBUG`); both reach the container only when set, so
# a deployment's default stays INFO. See src/managers/logger/config.ts.
LOG_LEVEL        ?=
LOG_MODULES      ?=
DENO_CMD         := $(if $(DENO_ARGS),deno run -A $(DENO_ARGS) src/primary-main.ts,)

help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-20s %s\n", $$1, $$2}'

# --- Setup ---

setup: container-build ## Build the EiN image (PostgreSQL and the services modules use run beside it)

# --- Container ---

# podman stages every committed layer through $TMPDIR before moving it into the graphroot, and
# the default /var/tmp is NOT the graphroot. In production the store is on the 1.8TB data disk while
# /var/tmp is on the 117GB root disk, so committing a large layer died with "no space left on
# device" against 1.4TB free in the store (the ~17GB VLM bake, when this image still carried
# the models). Staging beside the store instead is host-agnostic: wherever podman keeps its
# images is by definition sized for image-sized writes.
container-build: ## Build the EiN container image
	TMPDIR="$$(podman info --format '{{.Store.GraphRoot}}')/tmp"; \
	mkdir -p "$$TMPDIR"; \
	TMPDIR="$$TMPDIR" podman build -t $(IMAGE_NAME) -f src/Containerfile \
		.

# Settings reach the container through ENV_FILE; only the ports are set here.
#
# The built shell (src/builtin/ui/ui, gitignored) is mounted from the checkout over the image's
# copy, as the modules are at /modules-dev: a UI-only deploy replaces it without a rebuild.
#
# The comment lives here rather than inside the recipe because a `#` line between backslash
# continuations is handed to the SHELL, not read by make, and comments out the rest of the
# command.
container-run: ## Run the EiN container (ENV_FILE: its settings; MODULES_PATH: its modules; MODULE_INSTALL_PATH: what mod install installs)
	@mkdir -p $(FILE_ROOT_PATH) $(VOLATILE_FILE_ROOT_PATH) $(FILE_TMP_PATH) $(MODULE_INSTALL_PATH)
	podman run --replace -d \
		--name $(CONTAINER_NAME) \
		--restart $(CONTAINER_RESTART) \
		--stop-timeout $(CONTAINER_STOP_TIMEOUT) \
		--memory $(CONTAINER_MEMORY) --memory-swap $(CONTAINER_MEMORY_SWAP) \
		--network=host \
		-e POSTGRES_URL=$(POSTGRES_URL) \
		-e CFG_HTTP_PORT=$(HTTP_PORT) \
		-e CFG_SSH_PORT=$(SSH_PORT) \
		-e FILE_ROOT_PATH=/files \
		-e VOLATILE_FILE_ROOT_PATH=/files-volatile \
		-e FILE_TMP_PATH=/files-tmp \
		-e DEV_MODULES_PATH=/modules-dev \
		-e MODULE_INSTALL_PATH=/modules-installed \
		-e TZ=$(TZ) \
		$(if $(ENV_FILE),--env-file $(ENV_FILE),) \
		$(if $(INSTALL_MODULES),-e INSTALL_MODULES='$(INSTALL_MODULES)',) \
		$(if $(GUIDE_PATH),-e DOCS_PATH=/guide-dev -v $(GUIDE_PATH):/guide-dev:ro,) \
		$(if $(LOG_LEVEL),-e LOG_LEVEL=$(LOG_LEVEL),) \
		$(if $(LOG_MODULES),-e LOG_MODULES=$(LOG_MODULES),) \
		-v $(FILE_ROOT_PATH):/files \
		-v $(VOLATILE_FILE_ROOT_PATH):/files-volatile \
		-v $(FILE_TMP_PATH):/files-tmp \
		-v $(OLD_PATH):/old \
		-v $(MODULES_PATH):/modules-dev:ro \
		-v $(MODULE_INSTALL_PATH):/modules-installed \
		-v $(PWD)/src/builtin/ui/ui:/app/src/builtin/ui/ui:ro \
		$(IMAGE_NAME) $(DENO_CMD)

container-stop: ## Stop the EiN container
	podman stop -t $(CONTAINER_STOP_TIMEOUT) $(CONTAINER_NAME)

container-logs: ## Tail the EiN container's logs
	podman logs -f $(CONTAINER_NAME)

container-shell: ## Open a bash shell in the running EiN container
	podman exec -it $(CONTAINER_NAME) bash

# --- Dev ---

dev: ## Run primary instance
	deno task dev

dev-watch: ## Run primary instance with watch
	deno task dev-w

bundle-ui: ## Bundle UI
	deno task bundle-ui

bundle-ui-watch: ## Bundle UI with watch
	deno task bundle-ui-w

# --- Quality ---

test: ## Run tests (fast in-memory tier)
	deno task test

test-pg: ## Run tests incl. the PostgreSQL tier (needs make db)
	EIN_TEST_PG=$(POSTGRES_URL) deno task test

# Only every module's `*.e2e.test.ts`: the rest is the fast tier, which `make test` already runs,
# and inside this image it would run against the real services ENV_FILE points at.
#
# The tier's file root lands under /files-tmp, so a service that mounts the same directory at the
# same path can read what a test uploads.
E2E_TESTS = $(sort $(shell find modules -path '*/test/*' -name '*.e2e.test.ts'))

container-test: ## Run the modules' E2E tier inside the EiN image (needs make container-build; ENV_FILE: the services it reaches)
	@mkdir -p $(FILE_TMP_PATH)
	podman run --rm \
		--memory $(CONTAINER_MEMORY) \
		--network=host \
		-e EIN_TEST_CONTAINER=1 \
		-e EIN_TEST_FILE_ROOT=/files-tmp \
		$(if $(ENV_FILE),--env-file $(ENV_FILE),) \
		-v $(FILE_TMP_PATH):/files-tmp \
		-v $(PWD):/work:ro \
		-w /work \
		--entrypoint deno \
		$(IMAGE_NAME) \
		test --allow-all --config /work/deno.jsonc $(E2E_TESTS)

check: ## Type check
	deno task check

lint: ## Lint
	deno task lint
