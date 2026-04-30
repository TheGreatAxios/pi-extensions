# pi-multi-provider-manager

Multi-account provider extension for [pi](https://pi.dev). Lets you log into multiple ChatGPT/Codex, Fireworks AI, and Z.ai accounts simultaneously with an interactive guided setup.

## Quick Start

```bash
pi -e ./index.ts
/accounts  # opens interactive menu
```

## Interactive Flow

Running `/accounts` without arguments presents a guided menu:

1. **📋 List accounts** — Shows all configured accounts with their env vars
2. **➕ Add account** — Step-by-step provider selection, label input, and API key configuration
3. **🗑️ Remove account** — Select from list to delete
4. **🔁 Re-login** — Clear OAuth credentials for re-authentication (ChatGPT only)

## Commands

| Command | Description |
|---------|-------------|
| `/accounts` | Interactive guided menu |
| `/accounts add <kind> <label> [apiKeyEnv]` | Add account (kind: chatgpt, fireworks, zai) |
| `/accounts remove [kind] <label>` | Remove account |
| `/accounts list` | List all accounts |
| `/accounts relogin <kind> <label>` | Clear credentials and re-authenticate (OAuth only) |

## Architecture

Single-file extension (`index.ts`). Registers three multi-account providers (`openai-codex-accounts`, `fireworks-accounts`, `zai-accounts`) with internal account selection during OAuth. Credentials stored in pi's `auth.json` under provider keys; account labels in `~/.pi/agent/accounts.json`.

The guided UI uses `ctx.ui.select()` and `ctx.ui.input()` for menu-driven interaction, falling back to legacy CLI parsing when subcommands are provided.
