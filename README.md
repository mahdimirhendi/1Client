<div align="center">

<img src="assets/app-icon.png" width="112" alt="1Client app icon">

# 1Client

**A fast, native-feeling PostgreSQL and MySQL client for macOS,<br>with SSH tunnels and bastion hosts built in.**

[![CI](https://github.com/mahdimirhendi/1Client/actions/workflows/ci.yml/badge.svg)](https://github.com/mahdimirhendi/1Client/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![macOS 12+](https://img.shields.io/badge/macOS-12%2B-black?logo=apple)
![PostgreSQL and MySQL](https://img.shields.io/badge/databases-PostgreSQL%20%7C%20MySQL%20%7C%20MariaDB-336791)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/workspace-dark.png">
  <img src="docs/screenshots/workspace-light.png" alt="1Client: a SQL query with results, the schema sidebar and two open connections">
</picture>

1Client is a free, open-source database client for people who work with production databases
behind SSH. Connect directly, through one SSH server, or through a chain of jump hosts, with the
same ease. Every step of the connection is checked and explained when something fails, and every
connection is tagged with its environment so you always know where you are.

## Features

**Connect anywhere**
- PostgreSQL 12+, MySQL 5.7 / 8.x and MariaDB, with TLS (disable, prefer, require, or verify certificate).
- **Direct**, **SSH tunnel** or **bastion chain** (any number of jump hosts, like OpenSSH `ProxyJump`).
  Each hop signs in with the SSH agent (including 1Password's agent), a key file or a password.
- Host keys are checked against `~/.ssh/known_hosts` with OpenSSH rules, with *Trust and Retry* for new hosts.
- **Test Connection** walks through every step (reach the host, verify its key, sign in, reach the
  database, sign in, open the database) and tells you which one failed, why, and what to try.
- Paste a `postgres://` or `mysql://` URL to fill in the form, or open connections from other apps with a link.

**Write SQL**
- Syntax highlighting, find and replace, Format SQL, toggle comment and multiple cursors.
- Next-word suggestions that know your tables, columns and foreign keys
  (`JOIN customers c` → `ON o.customer_id = c.id`); Tab accepts.
- Run the statement under the cursor (⌘↵), the selection, or everything (⇧⌘↵), or use ▶ in the gutter.
- Errors exactly as the server reports them: code, SQLSTATE, detail, hint, and the position underlined.

**Work with results**
- A fast virtualised grid with types under column names, or a paged JSON view.
- **Sort** by clicking a column header: numbers, dates and text all sort correctly. Tables opened
  from the sidebar are sorted by the server, so the order covers the whole table.
- **Edit cells** in place, including setting nullable columns to `NULL`. Changes stay highlighted until
  you save (⌘S); they run as `UPDATE … WHERE <primary key>` in one transaction.
- Copy a value, a row, a row as JSON, a page or all rows, with a confirmation each time.

**Stay safe**
- Environment tags (Local, Staging, Production, or your own) with colors on every connection tab.
- *Ask before running writes* shows the exact SQL before anything changes; *Read-only session* refuses writes.
- Passwords are stored encrypted, or as 1Password `op://` references that are read when you connect.

**Feels like a Mac app**
- Light, dark, or follow macOS. A short, real menu bar, and short right-click menus.
- Tabs like a browser: one tab per connection, with query and table tabs inside it.

## Screenshots

| | Light | Dark |
|---|---|---|
| **Query and results** | <img src="docs/screenshots/workspace-light.png" alt="Query editor and results, light"> | <img src="docs/screenshots/workspace-dark.png" alt="Query editor and results, dark"> |
| **Connection through a bastion** | <img src="docs/screenshots/connection-light.png" alt="Connection sheet with two SSH hops, light"> | <img src="docs/screenshots/connection-dark.png" alt="Connection sheet with two SSH hops, dark"> |
| **Saved connections** | <img src="docs/screenshots/welcome-light.png" alt="Welcome window, light"> | <img src="docs/screenshots/welcome-dark.png" alt="Welcome window, dark"> |

## Install

### Download

Download the latest `.dmg` from [Releases](https://github.com/mahdimirhendi/1Client/releases/latest),
open it and drag **1Client** into **Applications**. It runs on Apple silicon and Intel Macs with
macOS 12 or newer.

### Build from source

You need macOS 12 or newer, the Xcode Command Line Tools (`xcode-select --install`),
[Rust](https://rustup.rs) 1.90+ and [Node.js](https://nodejs.org) 22.12+.

```sh
git clone https://github.com/mahdimirhendi/1Client.git
cd 1Client
npm install
npm run app        # builds 1Client.app and copies it to /Applications
```

`npm run dmg` builds a disk image instead (in `target/release/bundle/dmg/`).

## Getting started

1. Click **New Connection…** (⌘N), pick PostgreSQL or MySQL, and fill in the server, or paste a URL.
2. Under **Connect via**, choose *Direct*, *SSH Tunnel* or *Bastion Host* and add your hops. Enter the
   database host as the last hop sees it (often `localhost` or a private IP).
3. Pick an environment and the safety options, then click **Test Connection**.
4. **Save and Connect**. Double-click a table in the sidebar to browse it, or write SQL and press ⌘↵.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘N | New connection |
| ⌘T / ⌘W | New query tab / close tab |
| ⌘1 … ⌘8, ⌘9 | Show tab 1 to 8, or the last tab |
| ⇧⌘] / ⇧⌘[ (or ⌃Tab / ⌃⇧Tab) | Next / previous tab |
| ⌘↵ / ⇧⌘↵ | Run statement or selection / run everything |
| ⌘E | Show or hide the SQL editor |
| ⌘R | Run the tab's query again (refresh) |
| ⌘F / ⇧⌘F / ⌘/ | Find and replace / format SQL / toggle comment |
| ↩ or double-click | Edit the selected cell |
| ⌘⌫ | Set the selected cell to `NULL` |
| ⌘S | Save edited cells |
| ⌘C | Copy the selected cell |

## Open a database from another app

1Client registers the `oneclient`, `postgresql`, `postgres`, `mysql` and `mariadb` URL schemes, so
scripts, internal tools and other apps can open a connection in it:

```sh
open "oneclient://open?url=postgresql%3A%2F%2Fuser%3Apass%40127.0.0.1%3A5432%2Fdb&name=My%20DB"
open -b app.oneclient.desktop "postgresql://user:pass@127.0.0.1:5432/db"
```

The link opens a new connection tab and connects. It is kept in memory only, password included,
until you click **Save Connection**; if the same database is already open, that tab is shown instead.
Links and passwords are never written to logs.

| `oneclient://open` parameter | Meaning |
|---|---|
| `url` | Percent-encoded `postgresql://`, `postgres://`, `mysql://` or `mariadb://` URL (required). User, password and database are percent-decoded; `sslmode` is read and other parameters are ignored. |
| `name` | Tab name (optional). |
| `ssh` | `user@host[:port]`: connect through this SSH server. The database host in `url` is then as seen from it. |
| `jump` | `user@host[:port]`, repeatable or comma-separated: jump hosts before `ssh`, first hop first. |
| `ssh_agent` | `1password` for 1Password's SSH agent, or the path of an agent socket. Default: `SSH_AUTH_SOCK`. |
| `ssh_key` | Path of a private key to use instead of the agent. |

## Privacy and security

1Client sends no telemetry and connects only to the servers you configure. Everything it stores is in
`~/Library/Application Support/app.oneclient.desktop/`:

| File | Contents |
|---|---|
| `connections.json` | Saved connections, without passwords |
| `environments.json` | Your environment tags |
| `vault.json`, `vault.key` | Passwords and key passphrases, encrypted with ChaCha20-Poly1305; readable only by your user |

The vault keeps passwords out of plain-text files and backups, but its key lives next to it, so
software running as you could read it. For stronger protection, paste a 1Password reference
(`op://vault/item/field`) instead of a password: only the reference is stored, and the
[1Password CLI](https://developer.1password.com/docs/cli/) reads the secret when you connect.

*Read-only session* and *Ask before running writes* protect against mistakes; use database roles when
access has to be enforced. Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model).
To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Development

```sh
npm install
npm run tauri dev   # the app, with hot reload
npm run dev         # only the UI, in a browser, against a made-up backend (src/mock.ts)
npm run check       # TypeScript, predictor and sorting checks
cargo test --workspace
```

Live tests run against real servers; see the top of [`crates/core/tests/live.rs`](crates/core/tests/live.rs)
and [CONTRIBUTING.md](CONTRIBUTING.md).

```
crates/core/   Rust core: connections, encrypted vault, SSH tunnels, PostgreSQL and MySQL drivers (no UI code)
src-tauri/     Tauri shell: app state, the commands the UI calls, the macOS menu bar
src/           React + TypeScript UI: components/, lib/ (SQL parsing, sorting, editing), styles/
docs/          Architecture, design guidelines and screenshots
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how tunnels, sessions, results and editing work,
and [docs/DESIGN.md](docs/DESIGN.md) for the visual language.

## Roadmap

- Restore open tabs and query text on launch; query history and saved queries
- Cancel a running query, and a statement timeout setting
- Paging and filters in table tabs; insert and delete rows; a structure view (columns, indexes, DDL)
- Export results as CSV, TSV, JSON or `INSERT` statements
- Import hosts from `~/.ssh/config`; automatic tunnel reconnect
- Schema diagram, `EXPLAIN` view, query parameters
- Signed and notarized builds with automatic updates
- Redis and SQLite

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

1Client is released under the [MIT License](LICENSE).
