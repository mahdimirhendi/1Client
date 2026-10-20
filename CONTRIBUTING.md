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
npm run check                                              # types, predictor, sorting, SQL and diagram checks
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

## Releasing (maintainers)

Every push to the `release` branch publishes a new version automatically. To release what is on `main`:

```sh
git push origin main:release
```

The [Release workflow](.github/workflows/release.yml) then:

1. runs CI on that commit, and stops if anything fails;
2. picks the version: the one in `package.json` or, when that one is already released, the next patch
   number (0.1.0, 0.1.1, 0.1.2, …);
3. builds a universal disk image for Apple silicon and Intel Macs, signed (and notarized when the
   Apple secrets below are set);
4. publishes the release with the disk image and the changes since the last release, and tags the
   commit `vX.Y.Z`.

For a new minor or major version, set it on `main` first, then release as usual:

```sh
npm version 0.2.0 --no-git-tag-version   # updates package.json and package-lock.json
git commit -am "Start 0.2" && git push
git push origin main:release
```

### Signing and notarization (optional)

Without Apple credentials the app is ad-hoc signed, and people allow it once in System Settings the
first time they open it. With an [Apple Developer Program](https://developer.apple.com/programs/)
membership the workflow signs and notarizes the app instead, so it opens without any warning. Add
these repository secrets (Settings › Secrets and variables › Actions):

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | Your *Developer ID Application* certificate exported as `.p12`, base64-encoded: `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | The password you chose when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | The certificate's name, e.g. `Developer ID Application: Your Name (TEAMID)` (`security find-identity -v -p codesigning`) |
| `APPLE_ID` | The email of your Apple developer account |
| `APPLE_PASSWORD` | An app-specific password from [account.apple.com](https://account.apple.com) |
| `APPLE_TEAM_ID` | Your team ID, shown under Membership on [developer.apple.com](https://developer.apple.com/account) |

## Repository rules

`main` only changes through pull requests that pass CI and are approved by the maintainer
([CODEOWNERS](.github/CODEOWNERS)); only the maintainer can push to `release`. Contributors fork the
repository and open a pull request against `main`.

By contributing you agree that your work is released under the [MIT License](LICENSE).
