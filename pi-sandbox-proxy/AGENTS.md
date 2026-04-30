# pi-sandbox-proxy

Security proxy extension for [pi](https://pi.dev). Intercepts every bash command, identifies network operations, and enforces multi-layer security checks before execution.

## Quick Start

```bash
cd pi-sandbox-proxy && bun install
# With sandbox:  pi -e ../pi-sandbox/index.ts -e ./index.ts
# Standalone:    pi -e ./index.ts
```

## Commands

| Command | Description |
|---------|-------------|
| `/proxy` | Show status, approvals, blocked count |
| `/proxy-approve <subject> [days] [--wildcard]` | Pre-approve package/URL/domain |
| `/proxy-revoke <subject>` | Revoke approval |
| `/proxy-audit` | Show recent security events |

## Flags

| Flag | Description |
|------|-------------|
| `--no-proxy` | Disable entirely |
| `--proxy-strict` | Block all network unless explicitly approved |
| `--proxy-deep-scan` | Deep scan transitive dependencies |
| `--proxy-auto-approve` | Auto-approve zero-vuln packages (CI mode) |

## Architecture

Extension (`index.ts`) + 26 source files under `src/`. Dual-layer defense:

1. **Command Interception** (`pi.on("tool_call")`): 10 sequential checks including shell injection detection, unpinned version blocking, typosquatting warnings, lifecycle script blocking, OSV.dev vulnerability scanning, and interactive approval flows.

2. **Domain Whitelist Proxy**: HTTP/CONNECT proxy on host enforcing approved domains only; rejects private IPs.

Parsers: npm, pip, bun, curl, git, generic. Approvals stored at `~/.pi/agent/proxy-approvals.json` (max 30 days). Audit log at `~/.pi/agent/proxy-audit.log`.
