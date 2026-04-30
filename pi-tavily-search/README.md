# pi-tavily-search

AI-powered web search extension for [pi](https://pi.dev). Uses Tavily's search API to find current information, news, and authoritative sources.

## Install

```bash
pi install npm:@thegreataxios/pi-tavily-search
```

## Quick Start

```bash
/credential set tavily api_key <your_key>
# or: export TAVILY_API_KEY="your_key"
/tavily latest news about TypeScript 6
```

## API Key

Get a free API key at [tavily.com](https://tavily.com) (1,000 calls/month on free tier).

## Commands

- `/tavily <query>` — Search directly
- `tavily_search` tool — AI-triggered search with parameters

## Tool Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search query |
| `max_results` | number | 5 | Max 20 |
| `include_answer` | boolean | false | AI-synthesized summary |
| `search_depth` | basic/advanced | basic | advanced=thorough |
