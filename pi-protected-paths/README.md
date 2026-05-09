# pi-protected-paths

Safety net extension for [pi](https://pi.dev). Blocks `write`/`edit` operations to sensitive files so your coding agent doesn't accidentally corrupt critical project files.

## Install

```bash
pi install npm:pi-protected-paths
```

## Quick Start

```bash
pi -e ./index.ts
```

## What it protects

**Secrets & environment:** `.env`, `.env.*` (except `.env.example`), `.dev.vars`

**Auth & credentials:** `.npmrc`, `.yarnrc.yml`, `.yarnrc`, `.netrc`, `_netrc`, `service-account.json`, `credentials.json`

**SSH & private keys:** `.ssh/` directory, `id_rsa`, `id_dsa`, `id_ed25519`, `id_ecdsa`, `*.pem`, `*.key`, `*.p12`, `*.pfx`

**Cloud platform config:** `.aws/`, `.docker/`, `.gnupg/`

**Secrets management:** `.sops.yaml`, `.sops.yml`, `.vault-token`, `secrets/`

**Version control:** `.git/`, `.gitconfig`, `.git-credentials`

**Dependencies:** `node_modules/`

For the full table, see [AGENTS.md](./AGENTS.md).

## How it works

Hooks into pi's `tool_call` event. When a `write` or `edit` targets a protected path, it returns `{ block: true, reason: "..." }` and (if UI is available) shows a warning notification.

## Architecture

```
index.ts                     # Entry — activates protected paths
features/
└── protected-paths.ts       # tool_call hook with filename-aware blocking
```

Single dependency: `@earendil-works/pi-coding-agent`.
