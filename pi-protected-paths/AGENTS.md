# pi-protected-paths

Safety net extension for [pi](https://pi.dev). Blocks `write`/`edit`/`read` operations to sensitive files via `tool_call` hook.

## Quick Start

```bash
pi -e ./index.ts
```

## Protected Paths

### Directories (everything inside)

| Path | Reason |
|------|--------|
| `.git/` | Version control internals |
| `node_modules/` | Dependency tree stability |
| `.ssh/` | SSH keys and configuration |
| `.aws/` | AWS credentials and config |
| `.docker/` | Docker registry auth and TLS certs |
| `secrets/` | Secrets storage |
| `.gnupg/` | GPG private keys |

### Files (exact name)

| File | Reason |
|------|--------|
| `.env` | Environment variables / secrets |
| `.env.*` (e.g. `.env.local`, `.env.production`) | Environment-specific secrets |
| ~~`.env.example`~~ **allowed** | Template file, not secrets |
| `.dev.vars` | Cloudflare Workers secrets |
| `.npmrc` | npm registry tokens |
| `.yarnrc.yml` / `.yarnrc` | Yarn auth tokens |
| `.netrc` / `_netrc` | Machine login credentials |
| `credentials.json` | Generic cloud credentials |
| `service-account.json` | GCP service account keys |
| `.sops.yaml` / `.sops.yml` | SOPS encryption config |
| `.vault-token` / `.vault-token.json` | Vault auth tokens |
| `.gitconfig` | Git config (signing keys, credential helpers) |
| `.git-credentials` | Git stored plaintext credentials |
| `id_rsa`, `id_dsa`, `id_ed25519`, `id_ecdsa`, etc. | SSH private keys at project root |

### Files (by extension)

| Extension | Reason |
|-----------|--------|
| `*.pem` | PEM-encoded private keys / certs |
| `*.key` | Private key files |
| `*.p12` / `*.pfx` | PKCS12 keystores |
| `*.jks` / `*.keystore` | Java keystores |

## How it Works

Two layers of protection, both in the `tool_call` hook:

### Write/Edit Protection
When a `write` or `edit` tool call targets a protected path, returns `{ block: true, reason }`. (Original behavior.)

### Bash Read Protection (NEW)
When a `bash` tool call contains a command that reads a protected file, returns `{ block: true, reason }`. This stops agents from bypassing write restrictions by using shell tools.

Detected patterns:
- **Read commands** — `cat .env`, `grep KEY .env`, `head .env`
- **Input redirection** — `< .env`, `cat < .env`
- **Shell sourcing** — `source .env`, `. ./.env`
- **Copy/move** — `cp .env /tmp/`, `scp .env host:`
- **Command substitution** — `echo $(cat .env)`
- **Sandbox paths** — `cat /workspace/typescript/.env`
- **Protected dirs** — `.git/HEAD`, `node_modules/secret`, `.ssh/id_rsa`

`.env.example` is explicitly **allowed** (template file, not secrets).

## Architecture

```
index.ts                     # Entry — activates protected paths
features/
└── protected-paths.ts       # tool_call hook: write/edit + bash read detection
```

## Combining with Other Extensions

Use alongside [pi-sandbox-proxy](../pi-sandbox-proxy/) and [pi-container-sandbox](../pi-container-sandbox/) for full coverage:

```bash
pi -e ./index.ts -e ../pi-sandbox-proxy/index.ts -e ../pi-container-sandbox/index.ts
```

- **Protected paths** → blocks local file reads of secrets
- **Sandbox proxy** → blocks/gates all network operations
- **Container sandbox** → isolates filesystem in Docker

Single dependency: `@earendil-works/pi-coding-agent`.
