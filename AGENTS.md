# AGENTS.md

This file provides guidance when working with code in this repository.

## Project Overview

**pi-container-sandbox** — A [pi coding-agent](https://pi.dev) extension that intercepts every `read`, `write`, `edit`, and `bash` operation and runs it inside a per-session Linux container (Apple `container` CLI or Docker). Only the project cwd is bind-mounted; host secrets, SSH keys, home directory, and Docker socket are never exposed to the agent.

## Commands

```bash
# Install dependencies
cd pi-sandbox && npm install

# Build the sandbox image (one-time, ~3 min)
npm run build                    # auto-detects apple container or docker
npm run build-image:docker       # force Docker
npm run build-image:apple        # force Apple container

# Run pi with sandboxing enabled (default)
pi -e ./index.ts

# Run without sandboxing
pi -e ./index.ts --no-container  # or --noc

# With network access (for npm install, pip, etc.)
pi -e ./index.ts --container-net

# Keep container alive after exit (debugging)
pi -e ./index.ts --container-keep
```

No test suite or linter is configured (`check`/`clean` are no-ops in package.json).

## Architecture

Single-file extension at **`pi-sandbox/index.ts`** (~575 lines). Key layers:

### Runtime Abstraction (`Runtime` interface)
Two implementations behind a common `Runtime` interface:
- **`appleRuntime()`** — wraps Apple's `container` CLI (macOS 26+, Apple silicon). Uses `--no-dns` for network isolation, retries with fresh names on "already exists" race conditions.
- **`dockerRuntime()`** — wraps Docker. Applies `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512`, `--network none`.

Both run the container with `sleep infinity` as PID 1 (via `tini` in the image), then `docker exec` / `container exec` for each operation.

### Path Safety (`toRemote()`)
Translates host paths to `/workspace/<relative>` paths inside the container. Rejects any path resolving outside of the project cwd — the agent literally cannot access host files outside the mounted directory.

### Tool Interception
The extension registers four tools via `pi.registerTool()`. Each tool's `execute()` checks if a sandbox session exists:
- If sandboxed: creates a new tool instance with container-backed `*Operations` adapters
- If not sandboxed: delegates to local (host) filesystem tools

The four adapter functions (`readOps`, `writeOps`, `editOps`, `bashOps`) translate each operation into a `sh -c` command executed inside the container via `execCapture()` (returns Buffer) or `execStream()` (streams stdout/stderr).

### Session Lifecycle
- **`session_start`** → detects runtime, runs container, smoke-tests with `id -un && pwd`
- **`before_agent_start`** → rewrites cwd in system prompt from host path to `/workspace`
- **`user_bash`** event → routes `!` commands into the sandbox
- **`session_shutdown`** → stops container (unless `--container-keep`)
- Process-level cleanup hooks on `exit`/`SIGINT`/`SIGTERM` for ungraceful exits

### Sandbox Image (`docker/Dockerfile`)
Debian bookworm-slim based. Installs: bash, git, curl, nodejs, npm, python3, ripgrep, jq, make, etc. Runs as non-root user `pi` (uid/gid 1000) so bind-mounted files have predictable ownership.

## Conventions

- TypeScript with strict mode, ES2022 target, ESNext modules, Bundler resolution
- ESM imports only (`import ... from`)
- No test framework, no linter, no formatter configured
- Single dependency: `@mariozechner/pi-coding-agent` (pi SDK)
- All shell commands inside containers use POSIX sh (not bash-specific features where avoidable)
- File content is base64-encoded when writing to containers (avoids shell injection via heredocs)
