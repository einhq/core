# The daemon by its own name, not `pipeline engine` through the group
# dispatcher: the dispatcher now refuses to route to a `daemon: true` spec, so
# that typing `pipeline engine` at a shell cannot start a second engine on this
# queue. See src/managers/exec/commands/dispatch.ts.
pipeline-engine
