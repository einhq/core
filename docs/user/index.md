# EiN documentation

Welcome to EiN — _Everything Is a Node_ — a place to gather and document the
story of people's lives: photos, texts, events, and the locations and moments they
belong to.

Everything you see in EiN is organized as a tree of **nodes**, a bit like
files and folders on a computer. A node can be an album, a photo, a person, a
location, or a whole folder of other nodes. Understanding that shape makes the rest
of the app easy to navigate.

## Guide

- **[Getting started](getting-started.md)** — sign in, upload your first photos,
  and find your way around.
- **[The node tree](node-tree.md)** — how everything is arranged, and who may
  see what.
- **[Settings](settings.md)** — your own preferences, the system settings an
  administrator can change, and the accounts and groups they manage.
- **[The sidebar and top bar](navigation.md)** — hide, rename and add pages and buttons, for
  yourself or for everyone.
- **[Using the shell](shell-commands.md)** — the built-in command line and the
  handful of commands worth knowing.
- **[SSH & SFTP](ssh-sftp.md)** — connect from your own terminal or file
  manager to work with your content directly, and reach other machines from
  EiN: log in, copy files, or mount a folder from a NAS.

## Reference

These pages are not written by hand: they are read from this installation as you
open them, so they always match what is running.

- **[Commands](/docs/commands)** — every command on your PATH, with its
  options and examples.
- **[Settings](/docs/settings)** — every setting and its current value.
- **[Environment](/docs/environment)** — the environment variables EiN reads.
- **[Node types](/docs/node-types)** — every kind of node, and how many there are.
- **[Modules](/docs/modules)** — what is installed, and what each module brings.

The search at the top of the page looks through all of it at once. For
commands it searches by meaning as well as by name: _restart the web server_
finds `service restart`.

## How this documentation works

The guide lives inside EiN itself, under `/usr/docs/guide`, written in
Markdown and mounted from the EiN source, so it stays in step with the version
you are running. Each module can ship its own pages too; they appear on that
module's page under **Modules**.
