/**
 * Fetch Page Extension
 *
 * Allows fetching and parsing web pages from within Pi sessions.
 *
 * Two tools:
 *   - fetch_page      — returns the raw HTML source of a URL
 *   - fetch_text       — extracts clean, readable text (no HTML tags)
 */

import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
  fetchPage,
  formatHtmlResult,
  formatTextResult,
  FETCH_TIMEOUT_MS,
  MAX_TEXT_OUTPUT_CHARS,
} from "./fetch-page-lib";

// ---------------------------------------------------------------------------
// Helpers — delegated to fetch-page-lib.ts for testability
// (fetchPage, formatHtmlResult, formatTextResult are imported above)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const fetchParams = Type.Object({
  url: Type.String({ description: "The URL of the webpage to fetch" }),
});

/** Coerce raw tool call args into a valid { url: string }. */
function coerceUrlParams(raw: unknown): { url: string } {
  if (typeof raw === "string") return { url: raw.trim() };
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const key of ["url", "URL", "uri"]) {
      const val = o[key];
      if (typeof val === "string" && val.trim()) return { url: val.trim() };
    }
  }
  return { url: "" };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const fetchPageTool = defineTool({
  name: "fetch_page",
  label: "Fetch Page (HTML)",
  description:
    "Fetch the raw HTML source of a webpage. Returns the complete, unmodified HTML document including DOCTYPE, meta tags, scripts, etc.",
  promptSnippet:
    "Use fetch_page to get the full HTML source code of a specific URL.",
  promptGuidelines: [
    "Use this when you need to inspect or analyze the raw HTML of a webpage.",
    "Pass a full URL including https:// — the tool will add the protocol if omitted.",
  ],
  parameters: fetchParams,

  async execute(_toolCallId, params) {
    const { url } = coerceUrlParams(params);
    const result = await fetchPage({ url });
    return {
      content: [{ type: "text", text: formatHtmlResult(result) }],
      details: {
        statusCode: result.statusCode,
        contentType: result.contentType,
        finalUrl: result.finalUrl,
        sizeBytes: result.html.length,
      },
    };
  },

  renderResult(result, _options, theme) {
    let text = "";
    if (result.content && result.content.length > 0) {
      const firstContent = result.content[0];
      text = firstContent.type === "text" ? firstContent.text : String(firstContent);
    }

    // Show only the header + first few lines
    const lines = text.split("\n").slice(0, 6);
    return new Text(lines.join("\n"), 0, 0);
  },
});

const fetchTextTool = defineTool({
  name: "fetch_text",
  label: "Fetch Page (Text)",
  description:
    "Fetch a webpage and extract only the visible text content, excluding all HTML markup, scripts, styles, and navigation chrome.",
  promptSnippet:
    "Use fetch_text to get clean, readable plain text from a webpage — great for reading articles or documentation.",
  promptGuidelines: [
    "Use this when you want to read the actual content of an article, blog post, or page without HTML clutter.",
    "Pass a full URL including https:// — the tool will add the protocol if omitted.",
  ],
  parameters: fetchParams,

  async execute(_toolCallId, params) {
    const { url } = coerceUrlParams(params);
    const result = await fetchPage({ url });
    const output = formatTextResult(result);
    return {
      content: [{ type: "text", text: output }],
      details: {
        statusCode: result.statusCode,
        contentType: result.contentType,
        finalUrl: result.finalUrl,
        rawSizeBytes: result.html.length,
        textLength: output.length,
      },
    };
  },

  renderResult(result, _options, theme) {
    let text = "";
    if (result.content && result.content.length > 0) {
      const firstContent = result.content[0];
      text = firstContent.type === "text" ? firstContent.text : String(firstContent);
    }

    // Show first ~8 lines of extracted text for the TUI preview
    const lines = text.split("\n").slice(0, 8);
    return new Text(lines.join("\n"), 0, 0);
  },
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  // Register all tools
  pi.registerTool(fetchPageTool);
  pi.registerTool(fetchTextTool);

  // Notify on session start
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      "Fetch Page extension loaded — use fetch_page or fetch_text to retrieve webpages.",
      "info",
    );
  });

  // Command to check if a URL is reachable
  pi.registerCommand("fetch-check", {
    description: "Check if a URL is reachable and return HTTP status code",
    handler: async (args: Record<string, unknown>, ctx) => {
      const url = args.url ? String(args.url).trim() : args._?.[0] as string;
      if (!url) {
        ctx.ui.notify("Usage: /fetch-check <URL>", "warning");
        return;
      }

      try {
        const result = await fetchPage({ url });
        const statusText = result.statusCode === 200
          ? "OK"
          : result.statusCode >= 400
            ? "Error"
            : "Redirect";

        ctx.ui.notify(
          `${result.finalUrl} — ${result.statusCode} ${statusText}`,
          result.statusCode === 200 ? "success" : "warning",
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Fetch check failed: ${message}`, "error");
      }
    },
  });
}
