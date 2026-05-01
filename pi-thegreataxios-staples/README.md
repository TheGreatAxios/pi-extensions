# pi-thegreataxios-staples

Personal staple extensions for [pi](https://pi.dev). Bundles protected paths and plan mode into a single extension.

## Install

```bash
pi install npm:pi-thegreataxios-staples
```

## Quick Start

```bash
pi -e ./index.ts
```

## Features

### Protected Paths

Blocks `write` and `edit` operations to sensitive files.

| Path | Reason |
|------|--------|
| `.env` | Secrets and environment variables |
| `.git/` | Version control integrity |
| `node_modules/` | Dependency tree stability |

### Plan Mode

Read-only exploration mode with step tracking.

| Command | Action |
|---------|--------|
| `/plan` | Toggle plan mode |
| `/todos` | Show current plan progress |
| `Ctrl+Alt+P` | Toggle plan mode (shortcut) |
| `--plan` flag | Start in plan mode |

**Plan mode** restricts tools to read-only (`read`, `bash`, `grep`, `find`, `ls`, `questionnaire`) and filters bash through an allowlist. The agent creates a numbered plan under a `Plan:` header, then you choose to execute, refine, or stay in plan mode.

**Execution mode** restores full tool access, tracks `[DONE:n]` markers to mark steps complete, and shows a progress widget.

## Architecture

```
index.ts                          # Entry point — wires both features
features/
├── protected-paths.ts            # Blocks write/edit to protected paths
└── plan-mode/
    ├── index.ts                  # Plan mode lifecycle and event hooks
    └── utils.ts                  # Command allowlist, todo extraction, step tracking
```

Single dependency: `@mariozechner/pi-coding-agent`. All sub-packages (`pi-agent-core`, `pi-ai`, `pi-tui`) are resolved transitively.
