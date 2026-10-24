# Using the shell

EiN includes a small, bash-like **shell** for working with the node tree
directly. You can reach it from the terminal panel in the UI or over
[SSH](ssh-sftp.md). It's optional — everything important can be done from the
graphical interface — but the shell is handy for browsing, searching, and
scripting.

The tree works like a Unix filesystem: paths start at `/`, `.` is the current
node, `..` is the parent, and you move around with `cd`.

## Commands worth knowing

| Command        | What it does                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ls`           | List what's inside a directory (`ls -l` for details).                                                                 |
| `cd`           | Change into a directory.                                                                                              |
| `cat`          | Show the contents of a file.                                                                                          |
| `edit`         | Edit a text file in the terminal ([Editing files](#editing-files)).                                                   |
| `cp`           | Copy a node.                                                                                                          |
| `mv`           | Move or rename a node.                                                                                                |
| `rm`           | Remove a node (`rm -r` for a directory and its contents).                                                             |
| `mkdir`        | Create a directory.                                                                                                   |
| `du`           | Sum file sizes below paths (`du -chs *` for human-readable summaries and a total).                                    |
| `find`         | List nodes under a path, optionally filtered.                                                                         |
| `search`       | Search across your content.                                                                                           |
| `timeline`     | Everything that happened, newest first: albums, births, deaths, birthdays, wedding anniversaries, events, tracks.     |
| `news`         | What people added lately, newest first, from every module that tells news (the albums they made).                     |
| `events`       | Birthdays, memorials and wedding anniversaries around today (or `--today`), from every module that has events.        |
| `onthisday`    | What the archive has from this day (or a given `MM-DD`) in earlier years, newest year first, from every module.       |
| `dayinhistory` | Media taken on this day (or a given `MM-DD`) in past years, newest year first.                                        |
| `latest`       | The most recently captured media, newest first.                                                                       |
| `album-span`   | Write an album's span (its media's, widened to days set by hand) onto it, so it can be ordered by time.               |
| `album-cover`  | Give an album without a cover a random one of its own pictures; an existing cover is kept.                            |
| `device-cover` | Give a device its newest picture as its cover, or its newest video when it has no picture; a chosen cover is kept.    |
| `album-stack`  | Refresh or curate album-local stacks of similar consecutive photos.                                                   |
| `stat`         | Show a node's details (type, owner, timestamps).                                                                      |
| `ln -s`        | Create a softlink (shortcut) to another node.                                                                         |
| `ssh`, `scp`   | Log in to another machine, or copy files to and from it ([SSH & SFTP](ssh-sftp.md#reaching-other-machines-from-ein)). |
| `top`          | Watch the system live ([Watching the system](#watching-the-system)).                                                  |
| `ps`, `who`    | What is running now, and who is signed in.                                                                            |

Combine steps with `&&`, for example:

```
cd /archive/albums && ls -l
```

## Getting help

Every command accepts `--help` to show its options, and tab completion fills in
command names and paths as you type. The **[Commands](/docs/commands)** page
lists every command on your PATH with its options and examples, and the search
at the top of the documentation finds one by what it does:

```
search --help
assistant-commands find 'restart a service'
```

Add `JSON_OUTPUT=1` in front of a command to get its answer as JSON, which is
what the web interface itself reads:

```
JSON_OUTPUT=1 ls -l /archive/albums | jq '.[].name'
```

## Editing files

`edit <file>` opens a text file in a small terminal editor; a path that does not
exist yet becomes a new file when you save. The editor colors the text by its
language: from the file's name, its type, or a first line such as `#!bash`.
Markdown and plain text wrap at the window's edge; code scrolls sideways.

JSON, YAML and bash are checked as you type, and so are the `` ```json ``,
`` ```yaml `` and `` ```bash `` blocks in a Markdown file. A line with an error is
marked with ✗, and the status bar says what is wrong. Saving a file that has an
error asks first.

| Keys           | What they do                                            |
| -------------- | ------------------------------------------------------- |
| ^S (or ^O)     | Save                                                    |
| ^Q (or ^X)     | Quit; asks first when there are unsaved changes         |
| ^F             | Find; Enter goes to the next match                      |
| ^G             | Go to a line, or `line:column`                          |
| ^Z, ^Y         | Undo, redo                                              |
| ^K, ^U         | Cut the line (cuts in a row collect), paste             |
| Ctrl+←, Ctrl+→ | Move by word                                            |
| Home, End      | Start of the text on the line (again: of the line), end |
| Esc            | Cancel a question                                       |

## Watching the system

`top` fills the terminal with what the system is doing, and keeps it up to date: the CPU as a
graph of the last few minutes, memory and how quickly the server answers, free disk space, the
work the pipelines are doing and what is being processed right now, the commands running, who
is signed in, the services, and the latest warnings from the system log. Green, amber and red
mean the same as on the System page: amber from 75%, red from 90%. On a small terminal the
least important panels are left out.

| Keys         | What they do                                          |
| ------------ | ----------------------------------------------------- |
| q (or ^C)    | Quit                                                  |
| ↑ ↓, PgUp/Dn | Scroll the list of commands                           |
| s            | Sort the commands: newest, oldest, by user or by name |
| + and -      | Update less or more often (`top -d 5` starts at 5 s)  |
| p            | Pause, so a list can be read; again to go on          |
| Space        | Update now                                            |

`ps` lists the commands running now, with the `pid` that `kill` takes, and `who` lists who is
signed in — over SSH, in a terminal panel or in the web interface — the address each connects
from, and what each is running. Both show you your own; the administrator sees everyone's. A job
started with `&` is a process of its own, shown with what it runs (`bg: sleep 30 &`); its `pid` is
the one in `$!`, and killing it stops the whole job.

`health` says in one line whether the system is **healthy** (nothing waiting), **catching up**
(work waiting and getting done), **stuck** (work waiting and none of it done in the last hour) or
**needs a person**, and lists the checks that decide it: each kind of work with something
waiting, failed work, and what the media service reports about itself. `pool-stat` shows each kind of work in detail: how much is
left, how fast it goes, how long the oldest has waited, and why a kind is not moving. `gauges`
prints the meters services add beside the machine's own, such as the graphics card's memory.

## A few tips

- The terminal panel and an SSH login keep one shell, so `cd` and `export` last
  until you close it. A command run over `ssh host '…'`, or by the web interface,
  gets a shell of its own; chain what belongs together with `&&`.
- Quoting works as in bash: wrap paths that contain spaces in quotes, e.g.
  `ls "/archive/albums/Summer 2020"`.
- Values that start with a minus go after an equals sign, `--lng=-3.7`: on its
  own, `-3.7` would be read as another option.

For heavier file transfers or using your own tools, connect over
[SSH & SFTP](ssh-sftp.md) instead.
