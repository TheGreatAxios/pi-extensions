# pi-protected-paths

Safety net extension for [pi](https://pi.dev). Blocks `write`/`edit`/`read` operations to sensitive files so your coding agent doesn't accidentally corrupt critical project files or leak secrets.

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

Hooks into pi's `tool_call` event with two layers:

### Write/Edit Protection
When a `write` or `edit` tool call targets a protected path, it returns `{ block: true }` and shows a warning notification.

### Bash Read Protection (NEW)
Agents commonly **bypass** write/edit restrictions by using shell tools (`cat`, `grep`, `head`, `cp`, etc.) to read protected files directly. Protected-paths now intercepts every **`bash`** tool call and checks whether the command references a protected path as a **read target** — blocking it before execution.

Detected patterns:
| Pattern | Example | Blocked? |
|---------|---------|----------|
| Read command + path | `cat .env`, `grep KEY .env` | ✅ |
| Input redirection | `< .env`, `cat < .env` | ✅ |
| Shell sourcing | `source .env`, `. ./.env` | ✅ |
| Copy/move of protected file | `cp .env /tmp/`, `mv .env ../` | ✅ |
| Command substitution | `echo $(cat .env)` | ✅ |
| Sandbox-prefixed | `cat /workspace/typescript/.env` | ✅ |
| `.env.example` (template) | `cat .env.example` | ❌ (allowed) |

### Combining with pi-sandbox-proxy

Use alongside [pi-sandbox-proxy](../pi-sandbox-proxy/) for defense-in-depth:
- **Protected paths** blocks local file reads of secrets via bash
- **Proxy** gates all network operations (vuln scanning, approval flows)
- **Container sandbox** isolates filesystem operations in Docker

```bash
pi -e ./index.ts -e ../pi-sandbox-proxy/index.ts -e ../pi-container-sandbox/index.ts
```

## Architecture

```
index.ts                     # Entry — activates protected paths
features/
└── protected-paths.ts       # tool_call hook with filename-aware blocking
```

Single dependency: `@earendil-works/pi-coding-agent`.
