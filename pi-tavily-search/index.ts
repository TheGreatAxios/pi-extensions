/**
 * Tavily Search Extension for pi
 *
 * AI-powered web search using Tavily's API.
 * Zero dependencies — uses only Bun's built-in `fetch`.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-coding-agent";
import { Type, Static } from "typebox";

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string;
}

interface TavilyResponse {
  query: string;
  answer?: string;
  results: TavilySearchResult[];
  response_time: number;
}

const SearchParamsSchema = Type.Object({
  query: Type.String({
    description: "Search query string - be specific and include key terms for better results",
  }),
  max_results: Type.Optional(
    Type.Number({
      description: "Number of results to return (max 20, default 5)",
    })
  ),
  include_answer: Type.Optional(
    Type.Boolean({
      description: "Include AI-synthesized answer summarizing the search results",
    })
  ),
  search_depth: Type.Optional(
    Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
      description: "basic is faster and cheaper, advanced is more thorough for complex queries",
    })
  ),
});

type SearchParams = Static<typeof SearchParamsSchema>;

/**
 * Get Tavily API key from pi's credential store or environment
 */
async function getApiKey(ctx: ExtensionContext): Promise<string | null> {
  // Try pi's credential store first
  const credential = ctx.modelRegistry.authStorage.get("tavily");
  if (credential && credential.type === "api_key") {
    return credential.key;
  }
  // Fallback to environment variable
  return process.env.TAVILY_API_KEY || null;
}

/**
 * Search the web using Tavily's AI-optimized search engine.
 */
async function tavilySearch(
  ctx: ExtensionContext,
  params: SearchParams
): Promise<string> {
  const apiKey = await getApiKey(ctx);

  if (!apiKey) {
    return `Error: Tavily API key not configured.

Set it via: /credential set tavily api_key <your_key>
Or set environment variable: export TAVILY_API_KEY="your_key"

Get a free API key at: https://tavily.com`;
  }

  const maxResults = Math.min(params.max_results || 5, 20);
  const searchDepth = params.search_depth || "basic";
  const includeAnswer = params.include_answer ?? false;

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: params.query,
        max_results: maxResults,
        search_depth: searchDepth,
        include_answer: includeAnswer,
        include_raw_content: false,
      }),
    });

    if (!res.ok) {
      if (res.status === 401) {
        return "Error: Invalid API key. Check your Tavily credential.";
      }
      if (res.status === 429) {
        return "Error: Rate limit exceeded. Free tier allows 1,000 calls/month.";
      }
      const errData = await res.text();
      return `Error: Tavily API returned status ${res.status}: ${errData}`;
    }

    const data: TavilyResponse = await res.json();
    const results: TavilySearchResult[] = data.results || [];

    if (results.length === 0) {
      return "No results found for that query.";
    }

    const output: string[] = [];

    if (includeAnswer && data.answer) {
      output.push(`Answer: ${data.answer.trim()}\n`);
      output.push(`Sources:`);
    }

    results.forEach((r, i) => {
      const content = r.content.replace(/\s+/g, " ").trim();
      output.push(
        `[${i + 1}] ${r.title}\n` +
        `    URL     : ${r.url}\n` +
        `    Content : ${content}`
      );
    });

    return output.join("\n\n");
  } catch (err) {
    return `Error querying Tavily: ${err}`;
  }
}

/**
 * Extension factory function - called by pi when loading the extension
 */
export default function activate(pi: ExtensionAPI): void {
  // Register the tavily_search tool
  pi.registerTool({
    name: "tavily_search",
    label: "Tavily Search",
    description:
      "Search the web using Tavily's AI-optimized search engine. " +
      "Use this tool when: (1) the user asks about current events, news, or recent information, " +
      "(2) you need to verify facts or find authoritative sources, " +
      "(3) the user asks about specific websites, products, or technologies you're uncertain about, " +
      "(4) real-time data like prices, weather, or status is needed, " +
      "(5) you need to research a topic beyond your training cutoff.",
    parameters: SearchParamsSchema,
    execute: async (
      _toolCallId: string,
      params: SearchParams,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const result = await tavilySearch(ctx, params);
      return {
        content: [{ type: "text", text: result }],
        details: {},
      };
    },
  });

  // Register slash command for direct use
  pi.registerCommand("/tavily", {
    description: "Search the web using Tavily",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /tavily <search query>", "error");
        return;
      }
      const result = await tavilySearch(ctx, {
        query: args,
        max_results: 5,
      });
      ctx.ui.notify(result, "info");
    },
  });
}
