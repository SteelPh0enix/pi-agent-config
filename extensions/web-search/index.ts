/**
 * Web Search Extension
 *
 * Integrates a self-hosted web search engine into Pi as custom tools.
 * Provides general web search, news search, and image search capabilities.
 */

import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
  coerceQueryParams,
  webSearch,
  formatResults,
  SEARCH_BASE_URL,
  SEARCH_TIMEOUT_MS,
  formatImageResults,
} from "./search-lib";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shared renderResult: shows first N lines of text output in the TUI. */
function renderSearchResult(
  result: { content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown> },
  maxLines = 6,
) {
  let text = "";
  if (result.content && result.content.length > 0) {
    const firstContent = result.content[0];
    text = firstContent.type === "text" ? firstContent.text : String(firstContent);
  }

  const allLines = text.split("\n");
  const lines = allLines.slice(0, maxLines);
  if (allLines.length > maxLines) {
    const total = result.details?.totalEstimated as string | undefined;
    lines.push(`   ... (${total ?? "?"} total results)`);
  }

  return new Text(lines.join("\n"), 0, 0);
}

/** Build a search tool definition from shared config. */
function createSearchTool(config: {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  categories?: string;
  maxLines?: number;
}) {
  const { name, label, description, promptSnippet, promptGuidelines, categories, maxLines = 6 } = config;

  return defineTool({
    name,
    label,
    description,
    promptSnippet,
    promptGuidelines,
    parameters: Type.Object({
      query: Type.String({ description: `The ${label.toLowerCase()} query` }),
      page: Type.Optional(Type.Number({ description: "Page number for paginated results (default: 1).", minimum: 1 })),
    }),

    async execute(_toolCallId, params) {
      const { query } = coerceQueryParams(params);
      const page = params.page ?? 1;
      const searchOpts = categories === "images" ? { timeoutMs: SEARCH_TIMEOUT_MS } : undefined;
      const { results, totalEstimated } = await webSearch(
        { query, ...(categories && { categories }), page },
        searchOpts,
      );
      const formatted = categories === "images"
        ? formatImageResults(query, results, page)
        : formatResults(query, results, totalEstimated, page);
      return {
        content: [{ type: "text", text: formatted }],
        details: { resultCount: results.length, ...(categories !== "images" && { totalEstimated }), page },
      };
    },

    renderResult(result, _options, _theme) {
      return renderSearchResult(result, maxLines);
    },
  });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const webSearchTool = createSearchTool({
  name: "web_search",
  label: "Web Search",
  description:
    "Search the web using the self-hosted search engine. Uses your configured engines. Use this for general web searches.",
  promptSnippet:
    "Use web_search for general web searches to find up-to-date information.",
  promptGuidelines: [
    "Prefer web_search when the user asks a factual question that requires current knowledge.",
    "The search supports multiple engines simultaneously -- results are aggregated.",
  ],
});

const webNewsSearchTool = createSearchTool({
  name: "web_news_search",
  label: "Web News Search",
  description:
    "Search for recent news articles. Queries multiple news sources simultaneously.",
  promptSnippet:
    "Use web_news_search when looking for recent news or current events.",
  promptGuidelines: [
    "Use this when the user asks about recent events, breaking news, or current affairs.",
  ],
  categories: "news",
});

const webImageSearchTool = createSearchTool({
  name: "web_image_search",
  label: "Web Image Search",
  description:
    "Search for images using your configured sources. Returns URLs and captions.",
  promptSnippet:
    "Use web_image_search when the user needs to find images or visual content.",
  promptGuidelines: [
    "Use this when the user asks for pictures, photos, diagrams, or any visual content.",
  ],
  categories: "images",
  maxLines: 8,
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Register all tools
  pi.registerTool(webSearchTool);
  pi.registerTool(webNewsSearchTool);
  pi.registerTool(webImageSearchTool);

  // Notify on session start
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      "Web Search extension loaded — use web_search, web_news_search, or web_image_search.",
      "info",
    );
  });

  // Command to check search backend health
  pi.registerCommand("web-search-status", {
    description: "Check if the web search backend is reachable",
    handler: async (_args, ctx) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        const resp = await fetch(`${SEARCH_BASE_URL}/search?q=ping&format=json`, {
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (resp.ok) {
          ctx.ui.notify("Web search backend is reachable and responding.", "success");
        } else {
          ctx.ui.notify(
            `Search backend returned HTTP ${resp.status}. Service may be down.`,
            "warning",
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Web search unreachable: ${msg}`, "error");
      }
    },
  });
}
