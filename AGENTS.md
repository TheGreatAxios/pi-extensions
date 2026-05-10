# AGENTS.md

Design principles and architecture for pi coding-agent extensions.

## Philosophy

These extensions augment pi with security-first, composable capabilities:

- **Sandbox by default**: All agent operations run in isolated containers; host system is never exposed
- **Explicit over implicit**: Network access requires approval; versions must be pinned; secrets stay in env vars
- **Composable layering**: Extensions work standalone or together (sandbox → proxy → accounts)
- **Single-file where possible**: Core logic in one file for readability; only the security proxy is multi-file due to complexity

## Repository Structure

```
pi-extensions/
├── pi-multi-provider-manager/  # Multi-account providers (ChatGPT, Fireworks, Z.ai)
├── pi-container-sandbox/         # Container isolation for all agent operations
├── pi-sandbox-proxy/   # Security proxy with approval flows and vuln scanning
├── pi-protected-paths/      # Blocks write/edit/read to .env, .git, node_modules, SSH keys, credentials
└── AGENTS.md           # This file
```

## Design Patterns

### TypeScript
- Strict mode, ES2022, ESNext modules, Bundler resolution
- ESM imports only (`import ... from`); no `.js` extensions (Bun resolves natively)
- Single runtime dependency: `@earendil-works/pi-coding-agent`
- Use `bun` for everything: `bun install`, `bunx tsc`, `bun run`

### Tool Interception
Extensions use `pi.registerTool()` and `pi.on("tool_call")` hooks to intercept operations:
- **Sandbox**: Replaces filesystem/bash tools with container-backed adapters
- **Proxy**: Inspects bash commands pre-execution for security policy enforcement

### Path Safety
All paths translated to container-relative (`/workspace/<relative>`). Operations rejecting paths outside project cwd.

### Session Lifecycle
- `session_start`: Initialize resources (containers, proxy server)
- `before_agent_start`: Rewrite system prompt context
- `session_shutdown`: Cleanup (unless `--keep` flags)
- Process-level hooks on `exit`/`SIGINT`/`SIGTERM` for ungraceful exits

## Packages

| Package | One-liner | Location |
|---------|-----------|----------|
| **pi-multi-provider-manager** | Multi-account provider extension for ChatGPT/Codex, Fireworks AI, and Z.ai | [`pi-multi-provider-manager/`](./pi-multi-provider-manager/) |
| **pi-container-sandbox** | Runs every agent operation inside an isolated Linux container | [`pi-container-sandbox/`](./pi-container-sandbox/) |
| **pi-sandbox-proxy** | Security proxy with approval flows, vulnerability scanning, and supply chain enforcement | [`pi-sandbox-proxy/`](./pi-sandbox-proxy/) |
| **pi-protected-paths** | Blocks write/edit/read to .env, .git, node_modules, SSH keys, credentials, and other sensitive files | [`pi-protected-paths/`](./pi-protected-paths/) |

See each package's `AGENTS.md` for detailed architecture, commands, and quick start.
