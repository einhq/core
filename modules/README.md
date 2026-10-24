# modules

Module checkouts, one per directory, for developing and running modules against this core. Each
module is a repository of its own; clone the ones you want here under their own names, for
example `modules/archive`. Core names none of them, and its own tests run with none present.

A module installed with `mod install` does not come here: it goes to the folder mounted as
`MODULE_INSTALL_PATH` (`modules-installed/`), and one of the same name here runs instead.
