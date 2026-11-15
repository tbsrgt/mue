# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through GitHub: **Security** tab → **Report a vulnerability** (private vulnerability reporting). We aim to acknowledge reports within a few days.

## Scope

Mue is designed to run locally on source code you trust:

- the CLI reads COBOL sources and writes Java files and reports;
- Mue Studio is a local development server with no authentication, storing data in `data/mue.db`. Do not expose it to a network you do not control.

Relevant reports include: code execution or path traversal from crafted COBOL, JCL or recorded-input files; script injection in the generated HTML reports; any network call made by default (Mue should make none).

## Supported versions

Mue is pre-1.0: only the latest release receives fixes.
