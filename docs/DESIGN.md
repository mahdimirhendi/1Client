# Design guidelines

1Client should feel like a Mac app that ships with the system: quiet, dense, and readable, with
safety cues that are impossible to miss on production. This page explains the visual language so
changes stay consistent. All colors, sizes and radii live in
[`src/styles/tokens.css`](../src/styles/tokens.css); components use the tokens, never raw values.

## Look

- System font (SF Pro) at 13 px, SF Mono for data and SQL. No web fonts.
- One accent color, Apple blue (`#0068D6` light, `#0A84FF` dark). Status colors are used for status only.
- Gray chrome (toolbar, sidebar), white content. Hairline separators instead of heavy borders.
- Forms are grouped lists in the style of System Settings: label on the left, value on the right, 40 px rows.
- Every connection carries an environment tag. Production is red by default.

## Light and dark

- The app follows System Settings › Appearance and switches live. Light, Dark and Match macOS can
  also be chosen in the app (welcome screen, sidebar footer, View › Appearance).
- In dark mode surfaces get darker in steps (window `#1E1E20`, chrome `#2B2B2E`, sheets `#252528`,
  cards `#2C2C2F`), text gets lighter and hairlines become white at low opacity.
- Accent and status colors use the brighter dark variants (blue `#0A84FF`, green `#30D158`, red `#FF453A`).

## Window model

```
Window
└── ConnectionTab[]        top bar, one per open connection
    ├── sidebar            Tables (schema tree, grouped by schema) | Saved | History, with a filter
    ├── tunnel status
    └── DocumentTab[]      inner bar, per connection
        ├── Query          SQL editor and its results
        └── Table          a table opened from the sidebar (editor hidden, sortable on the server)
```

- A connection tab shows the engine badge, name, environment and number of open tabs. A 2 px line in
  the environment color marks the active connection.
- `+` on the connection bar opens the welcome screen; `+` on the inner bar opens a new query.
- Query tabs are numbered with the lowest free number. Closing the last tab leaves the connection open
  with an empty state.
- A tab opened from a saved query carries its name; a • after the name means it changed since it was
  saved, and ⌘S saves it.

## Connection sheet

1. **Pick the engine** (PostgreSQL or MySQL), or paste a URL (`postgres://…`, `mysql://…`) to fill the fields.
2. **Details**: host, port, user, password, database and SSL mode.
   - Passwords are saved encrypted by 1Client. A pasted `op://vault/item/field` reference is read from
     1Password when connecting instead. Every password field has an eye button to show or hide it; when
     editing, it shows the saved password, which is only fetched at that moment.
   - **Connect via** Direct, SSH Tunnel (one server), or Bastion Host (an ordered list of hops, like
     OpenSSH `ProxyJump`, each with its own user, port and sign-in).
   - A route strip shows the path, for example `This Mac → bastion → app-01 → db.internal:5432`.
   - **Safety**: environment, "Ask before running writes", "Read-only session".
3. **Test Connection** runs every step (reach host, verify host key, sign in, reach the database, sign in,
   open the database) and says which one failed, with the server's message and a hint.

## Query editor and results

- A run button in the gutter starts each statement; the statement under the cursor gets a light band.
- ⌘↵ runs the statement (or the selection), ⇧⌘↵ runs everything.
- Errors keep everything the server sent: code, SQLSTATE, detail, hint, and the position (underlined).
- The grid shows each column's type under its name. Numbers are right-aligned, NULL is a gray pill,
  alternate rows are tinted, edited cells are amber until saved.
- Clicking a header sorts ascending, then descending, then back to the original order.
- Table tabs have a filter bar above the grid: column, operator and value per row, joined with
  "Match all" or "Match any", and an SQL mode for a condition typed by hand. Enter applies.
- Below the grid of a table tab, a pager shows the rows on screen ("Rows 201–400 of 4,532") with
  first / previous / next / last buttons, and Count Rows when the total isn't known yet.
- Copy actions confirm with a short toast at the bottom of the window.

## Environments and color tags

- Local, Staging and Production come built in. Users can add their own and rename, recolor, reorder or
  remove any of them. Removing one moves its connections to Local.
- Each environment has one base color. The tag uses a darker (light mode) or lighter (dark mode) text
  color on a 14 % / 24 % fill of it; the connection tab stripe uses the base color.
- "Confirm writes" on an environment is the default for new connections in it, and turns the confirm
  button red.
- Palette: Gray `#8E8E93`, Red `#E5484D`, Orange `#F08C00`, Yellow `#D4A800`, Green `#30A46C`,
  Teal `#12A594`, Blue `#0090FF`, Indigo `#5B5BD6`, Purple `#8E4EC6`, Pink `#D6409F`, plus a custom color.
