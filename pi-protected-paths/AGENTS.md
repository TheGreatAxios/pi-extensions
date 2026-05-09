# pi-protected-paths

Safety net extension for [pi](https://pi.dev). Blocks `write`/`edit` operations to sensitive files via `tool_call` hook.

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

## Architecture

```
index.ts                     # Entry — activates protected paths
features/
└── protected-paths.ts       # tool_call hook with filename-aware blocking
```

Single dependency: `@earendil-works/pi-coding-agent`.
