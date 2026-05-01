# pi-thegreataxios-staples

Personal staple extension for [pi](https://pi.dev). Blocks writes/edits to sensitive files.

## Quick Start

```bash
pi -e ./index.ts
```

## Features

### Protected Paths

Blocks `write`/`edit` to sensitive files via `tool_call` hook:

| Path | Reason |
|------|--------|
| `.env` (exact file) | Secrets and environment variables |
| `.env.*` (e.g. `.env.local`, `.env.production`) | Environment-specific secrets |
| ~~`.env.example`~~ **allowed** | Template file, not secrets |
| `.dev.vars` | Cloudflare Workers secrets |
| `.git/` | Version control integrity |
| `node_modules/` | Dependency tree stability |

## Architecture

```
index.ts                     # Entry — activates protected paths
features/
└── protected-paths.ts       # tool_call hook with filename-aware blocking
```
