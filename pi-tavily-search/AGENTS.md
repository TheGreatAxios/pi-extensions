# pi-tavily-search

AI-powered web search extension for [pi](https://pi.dev). Registers a `tavily_search` tool and `/tavily` command using Tavily's search API.

## Quick Start

```bash
pi -e ./index.ts
/credential set tavily api_key <your_key>
# or: export TAVILY_API_KEY="your_key"
/tavily latest news about TypeScript 6
```

## Commands

| Command | Description |
|---------|-------------|
| `/tavily <query>` | Search the web directly |
| `tavily_search` tool | AI-triggered search with structured params |

## Tool Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search query — be specific |
| `max_results` | number | Max 20, default 5 |
| `include_answer` | boolean | Include AI-synthesized summary |
| `search_depth` | basic \| advanced | basic=faster, advanced=thorough |

## Architecture

Single-file extension (`index.ts`, ~150 lines). Zero dependencies beyond pi SDK — uses Bun's built-in `fetch`. API key resolved from pi's credential store (`/credential set tavily api_key`) or `TAVILY_API_KEY` env var. Free tier: 1,000 calls/month.
