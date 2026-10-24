# SSH & SFTP

Besides the web interface, EiN can be reached from your own terminal and file
manager over **SSH** (an interactive shell) and **SFTP** (file transfer). This is
useful for bulk uploads, downloads, scripting, and using tools you already know.
The other way round, EiN can [reach other machines](#reaching-other-machines-from-ein):
log in to them, copy files to and from them, and mount a folder from one.

You need:

- the **host**: `{{host}}`,
- the **SSH port**: `{{ssh.port}}`,
- your EiN **username** (`{{user}}`) and **password** — the same ones you sign
  in to the web interface with.

The commands below are filled in for this installation and for you, so they can
be copied as they are. Once you have [put your key in EiN](#signing-in-with-a-key),
you are no longer asked for the password.

## Signing in with a key

If you already use an SSH key on your own computer, give EiN its public half
once, and from then on `ssh` and `sftp` sign you in with the key. From your own
computer:

```
ssh-copy-id -s -p {{ssh.port}} {{user}}@{{host}}
```

It asks for your EiN password this one time. The `-s` matters: it makes
`ssh-copy-id` copy the key over SFTP, which EiN understands, rather than by
running shell commands that EiN's shell does not have.

The key is kept in `~/.ssh/authorized_keys` in your home in EiN, one key per
line, and you can add or remove lines there yourself. EiN only trusts that file
while no one but you can change it — `~/.ssh` must be mode `700` and the file
`600` (`ssh-copy-id -s` sets both) — since anyone able to write to it could
sign in as you. Lines with options in front of the key (`command="…"` and the
like) are ignored.

A disabled account cannot sign in at all, with a key or a password, and
disabling an account ends the SSH connections it already has open.

## Interactive shell over SSH

```
ssh -p {{ssh.port}} {{user}}@{{host}}
```

You land in the EiN [shell](shell-commands.md), where you can `ls`, `cd`,
`cat`, `search` and so on across the node tree, exactly as in the terminal panel
of the web interface. Every command is listed on the
[Commands](/docs/commands) page.

## One command at a time

Give SSH the command and it runs just that one, prints what it answers and
exits, which is what a script on your own computer wants. With `JSON_OUTPUT=1`
the answer is JSON:

```
ssh -p {{ssh.port}} {{user}}@{{host}} 'ls /archive/albums'
ssh -p {{ssh.port}} {{user}}@{{host}} 'JSON_OUTPUT=1 search "a sailboat"' | jq .
```

Each such command gets a shell of its own, so chain steps that belong together
with `&&`, as in `cd /archive/albums && ls`.

## File transfer over SFTP

Use `sftp`, or a graphical client such as FileZilla, Cyberduck, or your file
manager's "connect to server" feature, pointing it at the same host, port and
credentials.

```
sftp -P {{ssh.port}} {{user}}@{{host}}
```

Note the capital `-P` for the port in `sftp` (lower-case `-p` in `ssh`). Once
connected you can browse the tree and transfer files:

```
cd "/archive/albums/Summer 2020"
put sailboat.jpg
get lighthouse.jpg
```

Uploading a photo over SFTP into an album is the same as uploading it in the
web interface: EiN makes its thumbnails and reads its date and position the
same way.

## What looks different over SFTP

A photo in EiN keeps things of its own — its EXIF data, the faces found in
it, its thumbnails — and a file cannot hold other files in an ordinary file
system. Those live in a hidden folder named after the photo with `_` added:
the things belonging to `beach.jpg` are in `beach.jpg_`. It is not listed, so
copying an album with `cp -r` or rsync copies the photos without them, but you
can go into it by typing its name (`cd beach.jpg_`) and look around and download
at any depth. Nothing in it can be changed over SFTP. Removing the photo removes
it too.

A file's modification time is when its content last changed, not when EiN last
added something about it, so rsync and backup tools see a photo as unchanged
while its faces or description are being worked out. `rsync -t` and `put -p`
keep the times they set. A file can be emptied by setting its size to 0; other
size changes are refused.

Links — an album's cover, a picture added to an album, a person tagged in a
photo — appear as symbolic links, and following one takes you to what it points
to. A copy made with `cp -r` or rsync therefore copies the link rather than
everything behind it. `ln -s` in `sftp` makes a new link, and removing a link
removes only the link, never what it points to.

A link's target is a path in EiN, such as `/archive/people/anna-andersson`. When
EiN is mounted with sshfs, add `-o transform_symlinks` so such a target is
followed inside the mount rather than on your own computer.

## Reaching other machines from EiN

The EiN shell can also connect out, to a NAS, a backup server or any other
machine that runs SSH. This is for the administrator and for members of the
group `ssh`; everyone else is told they are not a member. The administrator
lets someone in with `group-add-member ssh anna`; it takes effect the next time
they sign in.

First make yourself a key and put it on the other machine. `ssh-copy-id` asks
for your password there once; after that the key is enough:

```
ssh-keygen
ssh-copy-id anna@nas.local
```

Then log in, run a command, or copy files between EiN and the other machine:

```
ssh anna@nas.local
ssh anna@nas.local 'df -h'
scp anna@nas.local:photos/sailboat.jpg "/archive/albums/Summer 2020/"
scp -r "/archive/albums/Summer 2020" anna@nas.local:backup/
```

These work like their namesakes on your own computer, for the options most
used: `-p` for the port (capital `-P` for `scp`), `-i` for another key, `-r` to
copy folders, `-p` to keep modification times, `-o StrictHostKeyChecking=accept-new`
and the like. A photo copied into EiN with `scp` is taken in just as an upload is. A folder copied out takes
only its files and folders, not what EiN adds to a photo or the links to
people and locations. In an `ssh` session, `~.` at the start of a line
disconnects.

A machine you use often can get a short name in `~/.ssh/config`, as on your own
computer:

```
Host nas
  HostName nas.local
  User anna
  Port 2222
```

after which `ssh nas` and `scp nas:photos/*.jpg /home/anna/` are enough. `HostName`,
`User`, `Port`, `IdentityFile`, `StrictHostKeyChecking`, `BatchMode`, `ConnectTimeout`,
`ServerAliveInterval` and `PasswordAuthentication` are read, with `Host`, `Match`
and `Include`; other settings are skipped. `-F` names another file, `-F none` none.

The first time you connect to a machine you are shown its key fingerprint and
asked whether to trust it; the answer is remembered in `~/.ssh/known_hosts`. If
the machine's key later changes you get a loud warning and no connection. When
you know why it changed, `ssh-keygen -R nas.local` forgets the old key.

### Mounting a folder from another machine

The administrator can make a folder on another machine appear in the tree, so
its files can be browsed, opened and copied like any other:

```
mkdir -p /mnt/nas
mount --save /mnt/nas sftp "host=nas.local,user=anna,path=/srv/photos"
```

`--save` mounts it again after every restart. Options: `host`, `port`, `user`,
`path` (the folder on the other machine), `key` (another key file), `hostkey`
(accept only this key, given as its `SHA256:` fingerprint), `uid`/`gid` (who
owns the files here) and `readonly`. The mount logs in with the administrator's
key, which should not have a passphrase, since the mount reconnects on its own.
`unmount --save /mnt/nas` removes it for good.

A mounted folder is a plain mirror: its files get no thumbnails or other
processing, and are not searched. Copy photos into an album to have them taken
in.

## Tips

- Paths are the same ones you see in the interface and the shell, such as
  `/archive/albums/<album name>/<file>`. Quote paths that contain spaces.
- An account that must choose a new password cannot sign in over SSH, even
  with a key, until it has: sign in to the web interface once and set one there
  first.
- Access is governed by the same permissions as the rest of EiN — you can
  only see and change what your account is allowed to.
