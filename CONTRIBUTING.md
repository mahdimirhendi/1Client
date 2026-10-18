# Contributing to 1Client

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and asking for features

Open an issue with what you did, what you expected and what happened. For connection problems,
the **Test Connection** report says which step failed; please include it, with host names and
users replaced if they are private. Never paste passwords or private keys.

Security problems go through private reporting instead; see [SECURITY.md](SECURITY.md).

## Setting up

You need macOS 12 or newer, the Xcode Command Line Tools (`xcode-select --install`),
[Rust](https://rustup.rs) 1.90 or newer and [Node.js](https://nodejs.org) 22.12 or newer.

```sh
git clone https://github.com/mahdimirhendi/1Client.git
cd 1Client
npm install
npm run tauri dev     # the app, with hot reload
npm run dev           # only the UI, in a browser, with a made-up backend
```

## Before opening a pull request

```sh
npm run check                                              # types, predictor and sorting checks
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Changes to drivers, tunnels or editing should also pass the live tests against real servers
(see the top of [`crates/core/tests/live.rs`](crates/core/tests/live.rs)). Containers are the easiest way:

```sh
docker run -d --rm --name pg -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=shop -p 55432:5432 postgres:16
docker run -d --rm --name my -e MYSQL_ROOT_PASSWORD=secret -e MYSQL_DATABASE=shop -e MYSQL_USER=app \
  -e MYSQL_PASSWORD=secret -p 53306:3306 mysql:8.4
ONECLIENT_TEST_PG=127.0.0.1:55432:postgres:secret:shop \
ONECLIENT_TEST_MYSQL=127.0.0.1:53306:app:secret:shop \
cargo test -p oneclient-core --test live -- --ignored
```

## Style

- Keep pull requests focused: one fix or feature each, with a short description of why.
- Rust is formatted with `rustfmt` (settings in `rustfmt.toml`) and must be free of clippy warnings.
- TypeScript is strict; match the style of the surrounding code.
- UI colors and sizes come from [`src/styles/tokens.css`](src/styles/tokens.css); see
  [docs/DESIGN.md](docs/DESIGN.md) for the visual language and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
  for how the pieces fit.
- Write comments that explain *why*, and user-facing text that says what happened and what to do next.

By contributing you agree that your work is released under the [MIT License](LICENSE).
