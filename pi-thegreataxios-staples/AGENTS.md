# pi-thegreataxios-staples

Personal staple extensions for [pi](https://pi.dev). Bundles protected paths and plan mode.

## Quick Start

```bash
pi -e ./index.ts
```

## Features

### Protected Paths

Blocks `write`/`edit` to `.env`, `.git/`, `node_modules/` via `tool_call` hook.

### Plan Mode

Read-only exploration with `/plan`, `Ctrl+Alt+P`, or `--plan` flag. Bash allowlisted to read-only commands. Extracts numbered steps from `Plan:` sections, tracks `[DONE:n]` markers during execution, shows progress widget. State persists across session resume.

## Architecture

```
index.ts                          # Entry — activates both features
features/
├── protected-paths.ts            # tool_call hook for write/edit blocking
└── plan-mode/
    ├── index.ts                  # Lifecycle: session_start, before_agent_start, turn_end, agent_end
    └── utils.ts                  # isSafeCommand, extractTodoItems, markCompletedSteps
```

Commands: `/plan`, `/todos`. Shortcut: `Ctrl+Alt+P`. Flag: `--plan`.
