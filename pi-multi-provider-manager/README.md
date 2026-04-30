# pi-multi-provider-manager

Multi-account provider extension for [pi](https://pi.dev). Log into multiple ChatGPT/Codex, Fireworks AI, and Z.ai accounts simultaneously.

## Install

```bash
pi install npm:@thegreataxios/pi-multi-provider-manager
```

## Quick Start

Run `/accounts` for a guided, interactive setup:

```
/accounts
→ 📋 List accounts
→ ➕ Add account
→ 🗑️ Remove account
→ 🔁 Re-login to account
→ ❌ Cancel
```

Or use CLI-style commands:

```bash
/accounts add chatgpt alice@gmail.com
/accounts add fireworks my-work FIREWORKS_API_KEY
/login  # pick "ChatGPT Accounts" or "Fireworks Accounts"
```

## Commands

Just type `/accounts` for an interactive menu, or use:

- `/accounts add <kind> <label> [apiKeyEnv]` — Add account (chatgpt, fireworks, zai)
- `/accounts remove [kind] <label>` — Remove account
- `/accounts list` — List all accounts
- `/accounts relogin <kind> <label>` — Re-authenticate OAuth accounts

## Setup Examples

**ChatGPT/Codex (OAuth):**
```
/accounts add chatgpt alice@gmail.com
# Then: /login → "ChatGPT Accounts"
```

**Fireworks AI (API key from env var):**
```
export FIREWORKS_API_KEY="fw-..."
/accounts add fireworks my-work FIREWORKS_API_KEY
# Then: /login → "Fireworks Accounts"
```

**Z.ai (API key from env var):**
```
export ZAI_API_KEY="z-..."
/accounts add zai production ZAI_API_KEY
```
