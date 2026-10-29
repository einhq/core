# The node tree

Everything in EiN is a **node** in a single tree, like files and folders —
hence the name, _Everything is a Node_.
Every node has a **type** that decides what it holds and how it behaves: an
album, a photo, a person, a location. You mostly meet them through the interface
without naming them, but knowing the shape helps when you browse the tree in the
[shell](shell-commands.md) or over [SSH/SFTP](ssh-sftp.md).

The full list of types, with how many of each this installation holds, is on the
**[Node types](/docs/node-types)** page. It follows what is installed: albums,
people and locations come from modules.

## Where things are

Albums, people, locations, devices and staging are there with the archive module.

| Path                  | What is there                                                |
| --------------------- | ------------------------------------------------------------ |
| `/archive/albums`     | Albums, and the photos and videos in them                    |
| `/archive/people`     | People                                                       |
| `/archive/locations`  | Locations                                                    |
| `/archive/devices`    | Cameras, phones and trackers, and the routes they recorded   |
| `/archive/tags`       | Labels, one folder per label                                 |
| `/home/<you>`         | Your own space: settings, shell history, staging             |
| `/home/<you>/staging` | New files to sort, by category, before they join the library |
| `/etc`                | Accounts, groups, settings and services                      |
| `/usr`                | Commands, modules and this documentation                     |
| `/var`, `/dev`        | What the system writes as it runs: logs, queues, jobs        |
| `/tmp`                | Temporary files, removed after a day by default              |

In the shell the system's folders have variables, so `cd $LOGS_PATH` works wherever they
live; the [Environment](/docs/environment) page lists them all.

## Links

A **softlink** points to another node somewhere else in the tree, and following
it takes you to its target. EiN uses them wherever one thing belongs in
several locations: an album's cover is a link to one of its pictures, a picture
added to an album is a link to where it lives, and a label is a folder of links
to what carries it. How two people are related is a pair of links too.

## Permissions

Like files on a computer, every node has an owner, a group, and permissions that
decide who can read or change it, written the way `chmod` writes them (`0750`).
A node may also grant access to further users or groups. The **Share** button on
an album, person, location or device, and **Share** in a photo's menu, set all of this
without the numbers; see [Default sharing](settings.md#default-sharing) for what a new album starts with.

## Sharing

**Share**, in an album's header, says who can see the album and lets whoever may change it decide:

- **Who can see it** — the album's visibility, as the chip under its title says it, and two
  presets: **Default**, everyone with an account can see it, and **Private**, only its owner can.
  A preset replaces the list below, for **Save** to apply.
- **People with access** — the owner, then everyone given access, each with **Can view** or
  **Can edit**. Add a person or a group in the box at the top; a row's menu changes what they may
  do or removes them. _Everyone with an account_ is the group everyone who signs in belongs to.
  **Save** applies the list to the album and everything in it.
- **Share with a link** — **Create link** makes an address anyone can open without an account:
  they see that album and nothing else, its photos without their details, each one theirs to
  download. Click the address to copy it, and send it. A link stops working after 30 days unless
  you pick another time, it says how often it has been opened, and **Delete link** stops it at
  once. A browser holds one link at a time: opening another album's link leaves the first.
- **With their own sharing** — photos in the album that keep sharing of their own. To keep a few
  private in a shared album, select them and choose **Share** in the bar at the bottom, then
  **Their own sharing**: they keep it when the album's sharing changes, and the album's link does
  not open them. **Share like the album** puts one back. If you may change the album, a lock in
  the corner of a photo, or of a folder, marks one that keeps its own sharing.

The chip under an album's title says how visible it is, and opens the same dialog: _Public_ (green)
when a link opens it, or visitors without an account see it while **Visitors may browse** is
on; _Restricted_ (orange) when not everyone with an account can see it; _Private_ (red) when only its owner can. An album everyone
with an account can see, as most are, has no chip.

## What you cannot see

EiN leaves out what you may not open. An album, photo or folder that is private to someone else
is not listed to you at all: not on Albums, not in News or search, not in `ls` or `find`. Here EiN
differs from a computer's files, where you see every name in a folder you can open, just not
what is inside them. So two people can see the same folder differently, and an album can look
emptier to you than to its owner.

What is hidden is still there, and that explains some surprises:

- **A folder can look empty and not be.** `rmdir` answers _Directory not empty_ and `rm` _Node not
  empty_ for a folder whose only contents are hidden from you.
- **A name can be taken by something you cannot see.** Moving something to that name fails with
  _Access denied for operation 'w'_, and creating a file under it does nothing.
- **Copying a folder fails if it holds anything you cannot read**, with _Access denied for
  operation 'r'_ naming the folder, rather than making a copy that is missing it.
- **Changing a folder's sharing leaves what you cannot see as it is.** Share, `share-set` and
  `chmod -r` say how many: _1 child the caller may not read left unchanged_.
- **Moving or renaming a folder takes everything in it along**, including what you cannot see.
- **Deleting a folder you may change with `rm -r` deletes everything in it**, including what
  you cannot see, as on a computer, where deleting needs only the right to change the folder.
- **Counts include hidden things.** An album's number of items counts photos you cannot see.

If something behaves as though it holds more than you see, ask its owner or an administrator:
they see all of it.
