/**
 * SearXNG Search Extension
 *
 * Integrates a self-hosted SearXNG search engine into Pi as a custom tool.
 * Uses the JSON API of SearXNG for web, news, images, and file searches.
 *
 * Instance: https://search.steelph0enix.dev/
 */

import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { searxngSearch, formatResults, SEARXNG_BASE_URL, SEARCH_TIMEOUT_MS, formatImageResults } from "./searxng-lib";

// ---------------------------------------------------------------------------
// Helpers — delegated to searxng-lib.ts for testability
// (searxngSearch and formatResults are imported above)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------
const searchParams = Type.Object({
  query: Type.String({ description: "The search query" }),
});

const newsSearchParams = Type.Object({
  query: Type.String({ description: "The news search query" }),
});

const imageSearchParams = Type.Object({
  query: Type.String({ description: "The image search query" }),
});

/** Coerce raw tool call args into a valid { query: string }. */
function coerceQueryParams(raw: unknown): { query: string } {
  if (typeof raw === "string") return { query: raw.trim() };
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    // Try common key names the LLM might use
    for (const key of ["query", "q"]) {
      const val = o[key];
      if (typeof val === "string" && val.trim()) return { query: val.trim() };
    }
  }
  // Last resort — prevent undefined from leaking through
  return { query: "" };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const searxngWebSearchTool = defineTool({
  name: "searxng_search",
  label: "SearXNG Search",
  description:
    "Search the web using the self-hosted SearXNG search engine. Uses your SearXNG instance's configured engines. Use this for general web searches.",
  promptSnippet:
    "Use searxng_search for general web searches to find up-to-date information.",
  promptGuidelines: [
    "Prefer searxng_search when the user asks a factual question that requires current knowledge.",
    "The search supports multiple engines simultaneously -- results are aggregated.",
  ],
  parameters: searchParams,

  async execute(_toolCallId, params) {
    const { query } = coerceQueryParams(params);
    const { results, totalEstimated } = await searxngSearch({ query });
    const formatted = formatResults(query, results, totalEstimated);
    return {
      content: [{ type: "text", text: formatted }],
      details: { resultCount: results.length, totalEstimated },
    };
  },

  renderResult(result, _options, theme) {
    const details = result.details as { resultCount: number; totalEstimated: string } | undefined;
    let text = "";
    if (result.content && result.content.length > 0) {
      const firstContent = result.content[0];
      text = firstContent.type === "text" ? firstContent.text : String(firstContent);
    }

    const lines = text.split("\n").slice(0, 6);
    if (text.split("\n").length > 6) {
      lines.push(`   ... (${details?.totalEstimated ?? "?"} total results)`);
    }

    return new Text(lines.join("\n"), 0, 0);
  },
});

const searxngNewsSearchTool = defineTool({
  name: "searxng_news_search",
  label: "SearXNG News Search",
  description:
    "Search for recent news articles using SearXNG. Queries multiple news sources simultaneously.",
  promptSnippet:
    "Use searxng_news_search when looking for recent news or current events.",
  promptGuidelines: [
    "Use this when the user asks about recent events, breaking news, or current affairs.",
  ],
  parameters: newsSearchParams,

  async execute(_toolCallId, params) {
    const { query } = coerceQueryParams(params);
    const { results, totalEstimated } = await searxngSearch({ query, categories: "news" });
    const formatted = formatResults(query, results, totalEstimated);
    return {
      content: [{ type: "text", text: formatted }],
      details: { resultCount: results.length, totalEstimated },
    };
  },

  renderResult(result, _options, theme) {
    const details = result.details as { resultCount: number; totalEstimated: string } | undefined;
    let text = "";
    if (result.content && result.content.length > 0) {
      const firstContent = result.content[0];
      text = firstContent.type === "text" ? firstContent.text : String(firstContent);
    }

    const lines = text.split("\n").slice(0, 6);
    if (text.split("\n").length > 6) {
      lines.push(`   ... (${details?.totalEstimated ?? "?"} total)`);
    }

    return new Text(lines.join("\n"), 0, 0);
  },
});

const searxngImageSearchTool = defineTool({
  name: "searxng_image_search",
  label: "SearXNG Image Search",
  description:
    "Search for images using SearXNG using your instance's configured sources. Returns URLs and captions.",
  promptSnippet:
    "Use searxng_image_search when the user needs to find images or visual content.",
  promptGuidelines: [
    "Use this when the user asks for pictures, photos, diagrams, or any visual content.",
  ],
  parameters: imageSearchParams,

  async execute(_toolCallId, params) {
    const { query } = coerceQueryParams(params);
    const { results, totalEstimated } = await searxngSearch(
      { query, categories: "images" },
      { timeoutMs: SEARCH_TIMEOUT_MS },
    );
    const formatted = formatImageResults(query, results);
    return {
      content: [{ type: "text", text: formatted }],
      details: { resultCount: results.length },
    };
  },

  renderResult(result, _options, theme) {
    let text = "";
    if (result.content && result.content.length > 0) {
      const firstContent = result.content[0];
      text = firstContent.type === "text" ? firstContent.text : String(firstContent);
    }

    const lines = text.split("\n").slice(0, 8);
    return new Text(lines.join("\n"), 0, 0);
  },
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  // Register all tools
  pi.registerTool(searxngWebSearchTool);
  pi.registerTool(searxngNewsSearchTool);
  pi.registerTool(searxngImageSearchTool);

  // Notify on session start
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `SearXNG Search extension loaded (instance: ${SEARXNG_BASE_URL.replace(/https?:\/\//g, "")})`,
      "info",
    );
  });

  // Command to check SearXNG instance health
  pi.registerCommand("searxng-status", {
    description: `Show SearXNG instance status -- checks reachability of ${SEARXNG_BASE_URL}`,
    handler: async (_args, ctx) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        const resp = await fetch(`${SEARXNG_BASE_URL}/search?q=ping&format=json`, {
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (resp.ok) {
          ctx.ui.notify("SearXNG instance is reachable and responding.", "success");
        } else {
          ctx.ui.notify(
            `SearXNG returned HTTP ${resp.status}. Instance may be down.`,
            "warning",
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`SearXNG unreachable: ${msg}`, "error");
      }
    },
  });
}
