# Security policy

1Client handles database passwords, SSH credentials and production data, so security reports are
taken seriously and handled before anything else.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through GitHub:
**Security → Report a vulnerability** on the repository page
([private vulnerability reporting](https://github.com/mahdimirhendi/1Client/security/advisories/new)).

Include what you found, how to reproduce it, and the impact you expect. You will get an answer
within a few days, and a fix or a plan once the report is confirmed. Credit is given in the release
notes unless you prefer otherwise.

## Supported versions

Fixes go into the latest release. 1Client is young (0.x), so please update before reporting.

## How 1Client protects your data

See [docs/ARCHITECTURE.md › Security model](docs/ARCHITECTURE.md#security-model) for where secrets are
stored, how host keys and TLS are checked, and what the safety settings do and don't guarantee.
