# pi-sandbox-proxy

Security proxy extension for [pi](https://pi.dev). Intercepts every bash command, identifies network operations, and enforces multi-layer security checks before execution.

## Quick Start

```bash
cd pi-sandbox-proxy && bun install
# With sandbox:  pi -e ../pi-container-sandbox/index.ts -e ./index.ts
# Standalone:    pi -e ./index.ts
```

## Combining with pi-container-sandbox

Use this alongside [pi-container-sandbox](../pi-container-sandbox/) for defense-in-depth:
- **Sandbox** isolates filesystem operations (containers, no host access)
- **Proxy** gates all network operations (vuln scanning, approval flows, typosquatting)

The proxy auto-detects whether the sandbox is loaded and what its network mode is.
If the sandbox has network disabled (`--no-container-net`), the proxy short-circuits
without prompting for approvals since the container has no network stack.

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
