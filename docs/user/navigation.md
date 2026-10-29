# Changing the sidebar and top bar

The pages in the sidebar and the buttons in the top bar are not fixed: every module adds its own,
and an administrator, for everyone or for one group, can change what shows, and so can you. Nothing
you change here is lost when EiN is updated, and an update still reaches everything you left alone.

To see what you get now — every entry, its id and where it leads — run this in the
[terminal](shell-commands.md):

```
ui-nav
```

## Your own changes

Write them to `.ui/nav.json` in your home directory. Neither the folder nor the file is there
until you make them; in the terminal, `mkdir -p ~/.ui` and then `edit ~/.ui/nav.json`. Name an
entry by its id and give only what should be different; reload the page to see it.

Rename Albums and move it to the top of its group, and hide Map:

```json
{
  "sidebar": [{ "id": "archive.albums", "label": "Photo albums", "order": 1 }],
  "hide": ["archive.map"]
}
```

Add a page of your own, here a search you use often, to the Explore group:

```json
{
  "sidebar": [
    { "id": "me.sailing", "section": "explore", "label": "Sailing", "icon": "sailboat", "to": "/search?q=sailboat" }
  ]
}
```

- `section` is one of the groups (`main`, `explore`, `browse`, `system`, or one you add under
  `"sections"`), `order` places the entry within it, lowest first.
- `icon` is the name of any icon at [tabler.io/icons](https://tabler.io/icons), as written there
  (`map-pin`, `heart` — and `heart-filled` for the filled one).
- `hide` takes anything away by id, a whole group too.

A top-bar button is an entry under `"topbar"` with a `title` (its tooltip), an `icon` and an
`action`: `{ "navigate": "/map" }` opens a page, `{ "dialog": "/people/new" }` opens one in a dialog
over the page, `{ "drawer": "/chat" }` in the panel at the side, `{ "fullscreen": "/map" }` over the
whole screen until Back or Escape, and `{ "run": "<a command>" }` runs a command, with `"navigate"`
beside it going where the command's answer says. Entries that name another as their `parent` become
rows of its dropdown, the way **Create** is made: its rows (Import media, Album, Person, Location,
Device) are each a module's entry with `"parent": "ui.create"`. Rows
with `"parent": "ui.account"` go in the menu under your picture, beside **Favourites**. A button
with `"place": "search"` stands beside the search box, as **Random album** does, rather than with
the others on the right.

A button or a dropdown's row can have a key, `"shortcut": "alt+R"`, which does what choosing it does
from anywhere outside a text field: modifiers (`alt`, `shift`, `ctrl`, `meta`, and `mod` for Ctrl,
or Cmd on a Mac) and one key, joined by `+`. **Random album** has Alt+R. The key shows in the
button's tooltip, beside the row and in the list `?` opens. A key already taken — by another entry, or by the app itself
(Ctrl+K, `?`, Alt+T and the terminal's other keys) — is not given twice,
and `"shortcut": null` takes a module's key away.

If something you wrote does not show, `ui-nav` says why: a missing field, a group that does not
exist, a file that is not valid JSON.

## For everyone

An administrator writes the same kind of file to `/etc/ui/nav.json`. It applies to every user,
before each user's own changes. Entries can be shown to administrators only with `"admin": true`,
and only to someone signed in — never to a visitor browsing without signing in — with
`"signedIn": true`.

## For a group

An administrator can also change the navigation for the members of one group, for example to give
the `sailors` group a page of its own. The file is `/etc/ui/groups/<group>/nav.json`, in the same
format:

```
mkdir -p /etc/ui/groups/sailors
edit /etc/ui/groups/sailors/nav.json
```

```json
{
  "sidebar": [
    { "id": "sailors.boats", "section": "explore", "label": "Boats", "icon": "sailboat", "to": "/search?q=sailboat" }
  ]
}
```

It is laid over `/etc/ui/nav.json` and under each member's own file. Someone in several such groups
gets each of them, in the order of the groups' names. The `guest` group's file is for visitors
browsing without signing in.
