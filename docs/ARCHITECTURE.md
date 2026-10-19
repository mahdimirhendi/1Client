# Architecture

1Client is a [Tauri 2](https://tauri.app) app. A Rust core does all networking, database and storage
work; a React UI runs in the system WebView and talks to it through Tauri commands.

```
React UI (src/)  ──invoke──▶  src-tauri (commands, app state)  ──▶  crates/core
                                                                 ├─ store.rs         saved connections (JSON)
                                                                 ├─ environments.rs  environment tags (JSON)
                                                                 ├─ queries.rs       query history and saved queries (JSON)
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
  wildcards, negation and `@revoked`. A host is trusted when any matching line has the same key. An
  unknown host stops the connection and the UI offers "Trust and Retry"; a changed key is a hard error.
- **Sessions.** One connection tab is one `Session`: an optional tunnel plus a single database
  connection, so `USE`, session variables and transactions behave as typed. Closing the tab drops both.
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
- **Filtering and sorting.** A table tab opened from the sidebar is filtered and sorted by the server
  (`WHERE …`, then `ORDER BY …` with NULLs last), so both cover the whole table. Filter values are
  always sent as quoted, escaped literals that the server converts to the column's type; text matching
  (`contains`, `starts with`, …) compares the column as text, ignoring case, with `!` as the `LIKE`
  escape character so `%` and `_` in a value are matched literally. A condition typed in SQL mode is
  used as written. Any other result is sorted in the grid by value: numbers, dates and times by value,
  text alphabetically.
- **Errors.** One `Error` type, serialised to the UI as `{ kind, message, … }`. Server errors keep every
  field (code, SQLSTATE, detail, hint, position); `unknownHostKey` carries the key for "Trust and Retry".
- **History and saved queries.** Both are kept per connection in the app's data folder and removed
  with the connection. A run from a query tab is recorded by the backend after it finishes, with its
  time, duration, rows or error; table browsing is not recorded, nor are connections opened from a
  link until they are saved. Running the same SQL again moves it to the top instead of adding a copy,
  and each connection keeps its latest 500 runs. A file that can't be read is moved aside
  (`*.json.invalid`) rather than stopping the app.
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
- Removing a connection, an SSH hop or a hop's password sign-in removes the matching secrets.
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
- `npm run check` type-checks the UI and runs the predictor, sorting and SQL checks.
- `npm run dev` runs the UI in a browser against `src/mock.ts`, a small in-memory backend with made-up data.
