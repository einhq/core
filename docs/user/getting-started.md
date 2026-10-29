# Getting started

This page walks through the first things you'll do in EiN.

## Signing in

Open EiN in your browser and sign in with the username (or e-mail address) and
password you were given. A fresh installation has an administrator account,
`admin`, whose first password the installation gives it: the installer prints it
when it is done, and without one EiN makes up a password and prints it once to the
server's log. Change it to one of your own once you are in: **Profile**, under
your picture at the top right, then the **Security** tab, or `user-passwd admin`
in the terminal.

Where the administrator has opened the archive to visitors (**Visitors may browse**, on the
**Permissions** tab of Settings), you can look around without signing in: you see what is shared
with visitors, and **Sign in** at the top right takes you to the form when you want more.

## Finding your way around

The menu on the left — behind the menu button on a phone — is your main
navigation. What is in it depends on the modules installed; with the archive and
the assistant it holds:

- **Home** — this day in earlier years, what people added lately, and the birthdays and anniversaries around today.
- **Chat** — ask the assistant about the archive in your own words.
- **Media** — every photo and video.
- **Search**, **Year** and **Map** — find content across everything.
- **Albums**, **People**, **Locations** and **Devices** — browse the archive by
  what it is about; a device's page shows the route it recorded.
- **Settings**, **Statistics** and **Documentation** — your preferences and
  the installed modules, how the archive has grown, and these pages. An
  administrator also has **Nodes** and **Dashboard**: the tree itself, and how
  the system is doing. The Dashboard opens on one word for how things stand:
  healthy, catching up, stuck or needs a person. After an upload it reads "catching up" until every
  photo and video has been looked at; nothing needs doing unless it says
  "stuck" or "needs a person" for long.

The search box at the top (Ctrl+K, or ⌘K on a Mac) finds pages, people,
albums and places as you type; Enter searches everything for the words. Start
with `>` to find a command instead.

**Staging**, in the sidebar, holds your uploads while they wait to be sorted
into albums, each in a category of its own if you like: a Google Photos export
in one, a box of scanned prints in another. **Import media**, in the
**Create** menu at the top (the plus), brings files in from anywhere: choose
the category, or make a new one, and the files. Your picture at the top right
opens your own pages: **Favourites**, the pictures you have hearted; your
profile and your trash.

## Uploading photos and files

Open an album you may change and choose **Upload** in its header, or drag files
straight onto the page: they go into that album. **Upload** on the Media page, like
**Import media**, puts them in your Staging to be sorted first. EiN stores each
file as a node and, for photos and videos, generates thumbnails and reads
embedded information such as the date and location automatically.

Behind the scenes an upload is a file written to a path under the album, for
example `/archive/albums/Holidays 2019/beach.jpg`. You normally never need to think about
the path — the UI handles it — but it's the same path you'd use over
[SFTP](ssh-sftp.md).

## Next steps

- Learn how [the node tree](node-tree.md) is arranged, and look up any
  [command](/docs/commands) or [setting](/docs/settings).
- If you prefer working from a terminal, read about the
  [shell](shell-commands.md) and [SSH & SFTP](ssh-sftp.md).
