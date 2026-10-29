# Settings

EiN has two kinds of settings: the ones that apply to the whole installation,
and the ones that are yours alone. They live in different locations, and only an
administrator can change the first kind. An administrator also manages the
accounts and groups there, under [Users, groups and permissions](#users-groups-and-permissions).

Every setting there is, with its current value and where that value came from,
is listed on the **[Settings](/docs/settings)** reference page.

## Your own settings

Open the user menu in the top right and choose **Profile**, then the
**[Preferences](/profile?tab=preferences)** tab. What you find there depends on which modules are installed,
but it typically includes:

- **Header entrance** and **Header entrance time** — how the tiles in a page's
  header arrive when the page opens (drawn and filled from the bottom up,
  falling into place, and more), and in how many milliseconds; 0 shows the
  header as it is.
- **Seconds per slide** and **Ken Burns effect** — how a slideshow behaves.
- **How widely what you create is shared** — where what you create as shared,
  such as a new album, starts out: private, shared with its group, or open to
  everyone. _Default_ follows whatever the administrator has chosen for the
  installation.
- **Shell history length** — how many commands the built-in terminal remembers.

Each field saves on its own: change it and **Save change** appears under it,
with **Cancel**. Once a setting is yours, **Restore inherited value** clears it,
so the value falls back to the system one.

Your settings are stored in a file called `.config` in your home directory, so
they apply in the terminal too — `echo $CFG_USER_SLIDESHOW_SECONDS` will show
what you chose.

## System settings

Administrators get a **System** tab on the **[Settings](/settings)** page.
These apply to everyone, and cover things like how much work runs in parallel, how much video
memory the graphics card may use, which AI models are loaded, and how
anything created as shared starts out.

Each setting says where its current value comes from:

- **Default** — nobody has changed it.
- **From deployment** — it was set when this EiN installation was started,
  usually in the host's configuration file. You can still override it here.
- **From _module_** — an installed module chose it, such as the assistant naming
  itself the reader of the search box. You can still override it here.
- **Set here** — an administrator changed it on this page.

Keys to other services — the media service's, a language model provider's —
are different. Nobody can read them back, administrators included: the page
says only whether one is set, by the deployment or here, and the field takes a
new one. Unlike other settings, a key is in no shell's environment, and EiN
sends it only to the address set for its service.

**A change takes effect without restarting EiN.** A service that reads the
setting only when it starts is restarted, and the page tells you which; work
already running is not lost, it is picked up again when the service comes back.
Everything else uses the new value from its next command on: the next picture
the pipeline looks for faces in, the next question to the assistant. A command
already running finishes with the value it started with. Two settings are exceptions: the HTTP and SSH ports cannot
restart their own server from a web page without cutting the connection you are
using, so they take effect the next time EiN starts.

## Default sharing

Three system settings decide how anything created as shared starts out:

- **Default permissions** — who may see it and who may change it: its owner,
  its group and everyone else, each with no access, view or edit. The Settings
  page offers None, View or Edit for each; `config` takes them as an octal mode
  the way `chmod` writes it, such as `0750`.
- **Default owner** — leave empty to let whoever creates it own it.
- **Default group** — the group that gets access. This is usually the
  interesting one: `users`, the default, means everyone with an account can see
  it, and a narrower group means only its members can. Left empty, it is the
  creator's primary group.

The button shows only on something that is not on them already, and resting the
pointer on it says what they are, owner included. The **Permissions** tab, under
[Users, groups and permissions](#users-groups-and-permissions), has them too, with
a sentence saying what they come to. The archive gives every new
album this sharing, narrowed or widened by its creator's own **How widely what
you create is shared**.

## From the terminal

Everything on both pages is also available as a command:

```
config list                 # every setting, with where its value comes from
config list --scope user    # just your own
config get CFG_CPU_SLOTS
config set CFG_CPU_SLOTS 4  # administrators only, for system settings
config unset CFG_CPU_SLOTS  # back to the default
```

## Modules

The **[Modules](/settings?tab=modules)** tab lists the installed modules: what
each one brings, whether it works, and what it needs. The button beside the
filter, **Add a module**, lists the **published modules** — the module
repositories of the places the **Module sources** setting names, such as
`https://github.com/einhq` — with each one's version, and whether it is
installed. An administrator installs one with **Install**, which brings the
modules it needs along with it, and gets **Update** where a newer version is
published than the one installed. Above the list, **From a repository** installs
from any repository's address, published or not, such as
`https://github.com/someone/module-name`; add `@` and a branch, tag or commit to
take other than its default branch (`…/module-name@v0.2.0`). A module installed
either way says where it came from in its panel, where it can be updated or
removed too: Update takes the newest commit of the branch it was installed from,
or the tag's again. One installed at a commit stays there, and its panel offers
no Update. Its pages and sidebar entries appear, or go, at once.

Installed modules are kept in a folder of their own beside EiN, not inside it,
so they stay when EiN is upgraded — as long as the installation keeps that
folder on its own disk, which the standard installation does. A module that
comes with the installation itself cannot be installed over; it is updated with
the installation.

A source on a forge that is not public, such as a Forgejo on the home network,
needs an access token: **Tokens for module sources** takes one per host, as
`forge.example:3000=token`, and each is sent to its own host only. The same is
there in the terminal:

```
mod search                  # the published modules, and what is installed of them
mod install archive         # by name, from the first source that has it
mod install https://github.com/einhq/module-archive@main
mod install archive@463a92f # at a commit, kept there; seven characters of its id or more
mod remove archive
```

## Users, groups and permissions

Administrators also get three more tabs on the Settings page, where accounts
and groups are made, changed and removed, and where what they start with is
set. On Users and Groups nothing opens over the page: pick someone or a group
from the list and change it in the pane beside it, and each change is made as
you make it. On a wide screen the list and the pane fill the window side by
side, each scrolling on its own; on a phone or in a narrow window they take
turns, and Back returns to the list. The button beside the list's filter makes
a new one.

- **Users** — everyone with an account. A dot on someone's picture means they
  are signed in now, and a badge says when they have no password or are
  disabled. Picking one shows their display name and description; the groups
  they are in, as a box per group: tick to put them in, untick to take them out
  (their primary group and `users` are ticked and grayed, with the reason beside
  them); their primary group; a new password; where they are signed in now; and
  whether they may sign in. **Disable sign-in** signs them out everywhere and
  keeps them out, without changing anything they own. **Delete account** removes
  their home folder and everything in it, and hands what they own elsewhere,
  such as albums and pictures, to an account you pick; their own group goes too,
  unless someone else is in it, and then it is kept. **New user** makes an
  account, in the default groups unless you untick them; it can't sign in until
  it has a password, which you can give it there or later.
- **Groups** — the groups things are shared with, each showing a few of its
  members' faces. Picking one shows its title and description, and its members
  as a box per account: tick to add, untick to remove. Someone whose primary
  group it is stays ticked and leaves only when their primary group is changed
  on their page. `users` has no list: everyone who signs in is in it. Deleting a
  group hands what it owned to a group you pick.
- **Permissions** — four cards: the groups a new account starts in besides its own
  (none, when left empty), whether visitors may browse, the
  [default sharing](#default-sharing), and how long a sign-in lasts. Each card
  says in a sentence what the saved values come to. Each setting is saved on its
  own, as on the System tab, and a value set here can be restored to the
  inherited one.

Worth knowing:

- **Group changes apply the next time someone signs in.** Whoever is signed in
  keeps the groups they signed in with until then.
- **Being in the group `admin` doesn't make anyone an administrator.** It is
  the `admin` account's own group, as `root`'s is on Linux. The system's own
  folders and settings are writable only by the `admin` account, not by its
  group, so a member can read them like anyone signed in but can't change them.
- **Built-in accounts and groups are marked, not hidden.** `admin` is the
  administrator, who can't be disabled or deleted. `guest` is who a visitor
  browses as: it has no password, can't be deleted, and its groups give it
  nothing. The groups `admin`, `users`, `ssh` and `guest` can't be deleted;
  everyone who signs in is in `users`, and `ssh` lets its members reach other
  machines (see [SSH & SFTP](ssh-sftp.md)).
- **An account made here gets a group of its own**, named like the account.
  These personal groups are hidden from the Groups list until you switch on
  **Show personal groups**, which is there only when there are some.
- **Disabled accounts are hidden from the Users list** until you switch on
  **Show disabled users**, which is there only when an account is disabled.

The same from the terminal:

```
user-create anna --title='Anna Andersson' --groups=users,family  # a new account, in these groups
user-passwd anna                 # give it a password; it asks for one
group-add-member family anna     # put anna in family
group-remove-member family anna  # take her out again
group-list --members             # every group, and who is linked into it
```
