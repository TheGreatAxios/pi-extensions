# pi-thegreataxios-staples

Personal staple extension for [pi](https://pi.dev).

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

### pi-system-prompt

Injects custom system prompt rules on every turn via `before_agent_start`.
Config files are discovered in priority order (first found wins):

1. `.pi/CUSTOM_SYSTEM_PROMPT_RULES.md` (project-level)
2. `~/.pi/agent/CUSTOM_SYSTEM_PROMPT_RULES.md` (global fallback)

The injected content sits under a `## Custom System Prompt Rules` section header.

#### Directives

Within the markdown file, you can inject full skill content:

```markdown
skill:apple-platform
```

This resolves against loaded skill directories (`~/.pi/agent/skills/`, `.pi/skills/`)
and replaces the directive line with the skill's full content.

#### Example

`~/.pi/agent/CUSTOM_SYSTEM_PROMPT_RULES.md`:

```markdown
- Always prefer `bun` over `npm`/`node`
- Use `const` by default, `function` only for hoisted declarations
- All new APIs must have TypeScript types
- Before writing any code, check if a utility already exists in `src/utils/`

skill:apple-platform
```

This injects the rules PLUS the full apple-platform skill into every turn's system prompt.

## Architecture

```
index.ts                        # Entry — activates all features
features/
├── protected-paths.ts          # tool_call hook with filename-aware blocking
└── pi-system-prompt/
    └── index.ts                # before_agent_start hook — resolves config + skill directives
```
