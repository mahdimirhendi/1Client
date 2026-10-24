# Architecture

1Client is a [Tauri 2](https://tauri.app) app. A Rust core does all networking, database and storage
work; a React UI runs in the system WebView and talks to it through Tauri commands.

```
React UI (src/)  ──invoke──▶  src-tauri (commands, app state)  ──▶  crates/core
                                                                 ├─ store.rs         saved connections (JSON)
                                                                 ├─ environments.rs  environment tags (JSON)
                                                                 ├─ queries.rs       query history and saved queries (JSON)
                                                                 ├─ diagrams.rs      diagram canvases (JSON, one file per connection)
                                                                 ├─ secrets.rs       encrypted vault + 1Password CLI
                                                                 ├─ known_hosts.rs   OpenSSH-compatible host key checks
                                                                 ├─ tunnel.rs        SSH chain → local port
                                                                 ├─ steps.rs         step-by-step connection report
                                                                 ├─ session.rs       tunnel + database connection
                                                                 ├─ edit.rs          UPDATE statements for grid edits
                                                                 ├─ link.rs          oneclient:// and database URLs
                                                                 └─ db/              postgres.rs, mysql.rs, introspection
```

`crates/core` has no UI or Tauri dependency, so it can be tested on its own and reused, for example
by a command-line tool.

## Choices

| Area | Choice | Why |
|---|---|---|
| App shell | Tauri 2 | Small app, Rust core, native window with the system WebView |
| UI | React 19, TypeScript, Vite, Zustand | Fast to build, good editor and grid libraries |
| Editor | CodeMirror 6 with `@codemirror/lang-sql` | Light and customisable (gutter run buttons, statement band, inline suggestions) |
| Grid | Custom grid on `@tanstack/react-virtual` | Full control over the look; stays fast with 10,000 rows |
| Diagram | Cards as DOM elements, lines as SVG, no library | Same look as the rest of the app; only what is in view is drawn |
| PostgreSQL | `tokio-postgres` with `postgres-native-tls` | Async and mature; the simple query protocol returns any type as text |
| MySQL / MariaDB | `mysql_async` with native TLS | Async; MySQL 5.7, 8.x and MariaDB |
| SSH | `russh` (pure Rust) | No OpenSSH dependency; `direct-tcpip` channels allow jump chains in-process |
| Secrets | Encrypted file (ChaCha20-Poly1305) | No Keychain prompts; 1Password references for anything stricter |
| Saved data | JSON in the app's config folder | Simple and easy to inspect or back up |

## How it works

- **Tunnels.** Hop 1 is a TCP connection. Each later hop runs a new SSH session inside a `direct-tcpip`
  channel of the previous one, which is what OpenSSH `ProxyJump` does. Before handing out a port,
  the last hop is asked to reach the database once, so a wrong database address fails at the right
  step. The last session then forwards a random local port on `127.0.0.1` to the database, and the
  driver connects there. TLS still uses the real host name, so certificates verify through a tunnel.
- **Host keys.** Checked against `~/.ssh/known_hosts` with OpenSSH rules: hashed hosts, `[host]:port`,
  wildcards, negation and `@revoked`. A host is trusted when any matching line has the same key. A
  host seen for the first time is trusted and added to the file, like `ssh -o
  StrictHostKeyChecking=accept-new`, and the connection test says so. A changed key stops the
  connection: the UI shows the new fingerprint and, only when the user confirms, removes the old key
  with `ssh-keygen -R` (which keeps `known_hosts.old`) and adds the new one.
- **Sessions.** One connection tab is one `Session`: an optional tunnel plus a single database
  connection, so `USE`, session variables and transactions behave as typed. Closing the tab drops both.
  Switching to another database opens a new database connection through the same tunnel; the saved
  connection keeps its database. On PostgreSQL the table tabs of the old database close; on MySQL,
  whose table tabs name their database, they stay, and the sidebar lists the chosen database only.
  The connection form's Browse lists the databases the same way, with the form's values.
- **Reconnecting.** When the connection drops (the Mac slept, the network changed, the server
  restarted), the session opens a new one by itself, tunnel included. Before a statement runs, a
  connection the driver or SSH already knows is closed is replaced; so is one that has been idle for
  30 seconds and doesn't answer a ping within 3, which is how a connection looks after sleep. If it
  drops while a statement runs, the statement runs again only when it only reads (the UI decides with
  the same check that asks before writes); anything else is reported as interrupted and never sent
  twice. A new connection is a new database session, so temporary tables, session variables and an
  open transaction are gone, and the UI shows "Reconnected".
- **Connection test.** Every step (reach host, verify host key, sign in, reach the database, sign in,
  open the database) is recorded with its time. A failure names the step, keeps the server's message
  and adds a hint; later steps are shown as not tried.
- **Results.** Values come back as text and `NULL` as null. Rows are read as they arrive and only the
  first 10,000 of each result are kept (`ROW_LIMIT`), so a large `SELECT` never has to fit in memory;
  the real row count is still reported. For a single statement the server is also asked for column
  types and, where it knows them, the table column each value comes from.
- **Editing.** A result column is editable when it comes from a table whose primary key is also in the
  result. Edits become one `UPDATE … WHERE <primary key>` per row, all in one transaction, and each
  must change exactly one row or everything is rolled back. PostgreSQL gets escaped literals (the
  confirmation dialog shows the exact SQL); MySQL uses bound parameters.
- **Filtering, sorting and paging.** A table tab opened from the sidebar is filtered, sorted and paged
  by the server (`WHERE …`, `ORDER BY …` with NULLs last, `LIMIT 200 OFFSET …`), so all of it covers
  the whole table. Without a chosen sort the rows are ordered by the primary key, so pages never
  overlap or skip rows. The row count is a separate `count(*)` run only when asked, because it can be
  slow on big tables. Filter values are
  always sent as quoted, escaped literals that the server converts to the column's type; text matching
  (`contains`, `starts with`, …) compares the column as text, ignoring case, with `!` as the `LIKE`
  escape character so `%` and `_` in a value are matched literally. A condition typed in SQL mode is
  used as written. Any other result is sorted in the grid by value: numbers, dates and times by value,
  text alphabetically.
- **Errors.** One `Error` type, serialised to the UI as `{ kind, message, … }`. Server errors keep every
  field (code, SQLSTATE, detail, hint, position); `hostKeyChanged` carries the new key for "Replace Key and Retry".
- **Saved data.** Every file in the app's data folder is replaced atomically (written next to it, then
  renamed over it). A file that can't be read at launch is kept as `*.invalid` for recovery and the app
  starts without it; for connections, environments and the password vault the welcome window says so.
- **History and saved queries.** Both are kept per connection in the app's data folder and removed
  with the connection. A run from a query tab is recorded by the backend after it finishes, with its
  time, duration, rows or error; table browsing is not recorded, nor are connections opened from a
  link until they are saved. Running the same SQL again moves it to the top instead of adding a copy,
  and each connection keeps its latest 500 runs. A file that can't be read is moved aside
  (`*.json.invalid`) rather than stopping the app.
- **Diagram canvases.** On PostgreSQL each database of a connection has its own canvases; on MySQL,
  where a connection sees every database, one set covers them all. A canvas stores only what the user
  chose and arranged: its scope (the whole database, name patterns, picked tables, or a table and the
  tables up to two foreign keys away), where each table sits, hidden tables and columns, notes, zoom,
  and the table and column names the user last saw. It never stores the schema. Each time a canvas is
  shown it is rebuilt from the live schema (`src/lib/diagram.ts`): new tables in scope are placed in
  free space (or wait unchecked in its panel), dropped tables stay as placeholders until removed, and
  what changed since the last look is listed until the user confirms it. Tables are keyed by
  `schema.table`. The layout puts referenced tables to the left of the tables that reference them.
  Only cards and lines near the view are drawn, and dragging one card leaves the others alone, so
  canvases of a thousand tables stay smooth. Changes are saved 300 ms after the last one, in
  `diagrams/<connection id>.json`, written atomically and removed with the connection; connections
  opened from a link keep none until saved. Export draws the canvas from the model as SVG (or PNG from
  it), and the app writes the file where the user picks in a native save panel, so the page never
  chooses a path.
- **Links.** `oneclient://open?url=…` and plain database URLs open a temporary connection, kept in
  memory with its password until the user saves it. Links are never logged and parse errors never
  contain the password.

## Security model

- Saved connections (`connections.json`) contain no secrets.
- Passwords and key passphrases are encrypted in `vault.json` with a random 256-bit key in `vault.key`.
  Both files are created readable only by the current user (mode `600`). The key sits next to the
  vault, so this protects against accidental exposure (a copied file, a backup, a screen share), not
  against software running under your account. For stronger protection, store an `op://` 1Password
  reference instead of the password; only the reference is saved and the secret is read on connect.
- Saved passwords are not sent to the UI. The edit sheet's eye button asks for one saved value of a
  saved connection when it is clicked, and nothing else returns them.
- Removing a connection, an SSH hop or a hop's password sign-in removes the matching secrets.
- An open connection keeps its passwords in memory, so it can connect again after sleep; they go
  when its tab is closed.
- SSL mode `require` encrypts without verifying the certificate (libpq semantics); "Verify certificate"
  checks the chain and host name and should be used wherever possible.
- "Read-only session" and "Ask before running writes" are safety nets against mistakes, not
  permissions. Use database roles when access must be enforced.
- A MySQL server cannot read local files through `LOAD DATA LOCAL INFILE`: no file handler is installed.
- The WebView's content security policy only allows the app itself and IPC; no remote content is loaded.
  1Client sends no telemetry and contacts no server except the ones you connect to.

## Testing

- `cargo test --workspace` runs the Rust unit tests.
- `crates/core/tests/live.rs` runs against real PostgreSQL, MySQL and SSH servers; it is ignored by
  default and configured with environment variables listed at the top of the file.
- `npm run check` type-checks the UI and runs the predictor, sorting, SQL and diagram checks.
- `npm run dev` runs the UI in a browser against `src/mock.ts`, a small in-memory backend with made-up data.
