/**
 * Pure library code for fetching and parsing web pages.
 *
 * Two capabilities:
 *   1. Raw HTML — fetch a URL and return the unmodified HTML source.
 *   2. Text-only  — fetch a URL, strip all HTML tags & scripts/styles,
 *                  normalize whitespace, and return clean text content.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_TEXT_OUTPUT_CHARS = 16_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface FetchResult {
  /** The HTTP status code (e.g. 200) */
  statusCode: number;
  /** Content-Type header value, if present */
  contentType?: string;
  /** Final URL after redirects */
  finalUrl: string;
  /** Raw HTML source of the page */
  html: string;
}

export interface FetchPageParams {
  url: string;
}

// ---------------------------------------------------------------------------
// Core fetch
// ---------------------------------------------------------------------------

/**
 * Fetches a URL and returns raw HTML.
 * Follows up to 5 redirects automatically (fetch does this by default).
 */
export async function fetchPage(
  params: FetchPageParams,
  opts?: { timeoutMs?: number },
): Promise<FetchResult> {
  const url = normalizeUrl(params.url);
  const timeout = opts?.timeoutMs ?? FETCH_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Pi-Extension/1.0 (Web Page Fetcher)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    clearTimeout(timer);

    const html = await response.text();

    return {
      statusCode: response.status,
      contentType: response.headers.get("content-type") ?? undefined,
      finalUrl: response.url,
      html,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch ${url}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

/**
 * Ensures a URL has a protocol prefix.
 */
export function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }
  // Basic validation — will throw if malformed
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// Text extraction (no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Strips HTML tags, script/style blocks, and normalizes whitespace
 * to produce clean plain text from an HTML document.
 */
export function htmlToText(html: string): string {
  let text = html;

  // Remove <script> and <style> blocks (including their contents)
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Replace block-level open/close tags with newlines, preserving inner content
  const blockTags = [
    "div", "p", "br", "hr", "section", "article", "aside",
    "header", "footer", "nav", "main", "ul", "ol", "li",
    "table", "tr", "td", "th", "thead", "tbody", "tfoot",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "pre", "figure", "figcaption",
    "details", "summary", "dl", "dt", "dd",
  ];
  for (const tag of blockTags) {
    text = text.replace(new RegExp(`<${tag}[^>]*>`, "gi"), "\n");
    text = text.replace(new RegExp(`</${tag}>`, "gi"), "\n");
    // Self-closing or empty block tags
    text = text.replace(new RegExp(`<${tag}[^>]*/>`, "gi"), "\n");
  }

  // Decode common HTML entities.
  // Non-&amp; entities are decoded first; &amp; is decoded last
  // (otherwise the & produced would break other entity references).
  const nonAmpEntities: Record<string, string> = {
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&mdash;": "\u2014",
    "&ndash;": "\u2013",
    "&hellip;": "...",
    "&lsquo;": "'",
    "&rsquo;": "'",
    "&ldquo;": '"',
    "&rdquo;": '"',
    "&bull;": "\u2022",
  };

  // First pass: decode all non-&amp; entities
  for (const [entity, char] of Object.entries(nonAmpEntities)) {
    const regex = new RegExp(entity.replace(/[.+*?^${}()|[\]\\]/g, "\\$&"), "gi");
    text = text.replace(regex, char);
  }

  // Last pass: decode &amp; → & (must be last!)
  text = text.replace(/&amp;/gi, "&");

  // Decode numeric entities (&#65; and &#x41;)
  text = text.replace(/&#([0-9]+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));

  // Remove remaining tags (e.g., <a>, <img>, etc.)
  text = text.replace(/<[^>]+>/g, "");

  // Remove attribute values from any leftover tags
  text = text.replace(/\s+(href|src|alt|class|id|data-[\w-]*)="[^"]*"/gi, " ");

  // Replace newlines and tabs with spaces
  text = text.replace(/[\t\r\n]+/g, "\n");

  // Normalize whitespace: collapse multiple spaces into one
  text = text.replace(/ {2,}/g, " ");

  // Trim lines and remove blank-line runs (keep at most one blank line)
  const lines = text.split("\n").map((l) => l.trimEnd());
  let result = "";
  let lastWasBlank = false;
  for (const line of lines) {
    if (line.length === 0) {
      if (!lastWasBlank) {
        result += "\n";
      }
      lastWasBlank = true;
    } else {
      result += line + "\n";
      lastWasBlank = false;
    }
  }

  return result.trim();
}

/**
 * Attempts to extract the main <title> from HTML.
 */
export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match) {
    let title = match[1].trim();
    // Decode basic entities in title
    const titleEntities: Record<string, string> = {
      "&lt;": "<",
      "&gt;": ">",
      "&#39;": "'",
      "&apos;": "'",
      "&quot;": '"',
      "&nbsp;": " ",
    };
    for (const [entity, char] of Object.entries(titleEntities)) {
      const regex = new RegExp(entity.replace(/[.+*?^${}()|[\]\\]/g, "\\$&"), "gi");
      title = title.replace(regex, char);
    }
    // Decode &amp; last
    title = title.replace(/&amp;/gi, "&");
    // Decode numeric entities
    title = title.replace(/&#([0-9]+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
    title = title.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
    return title;
  }
  // Fallback: try to extract from <meta> tags
  const metaTitleMatch = html.match(
    /<meta\s+(?:name|property)="(?:og:title|title)[^"]*"\s+content="([^"]*)"/i,
  );
  if (metaTitleMatch) return metaTitleMatch[1].trim();
  return "(no title found)";
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Formats a fetch result for display as raw HTML.
 */
export function formatHtmlResult(result: FetchResult): string {
  const lines: string[] = [];

  lines.push(`URL : ${result.finalUrl}`);
  lines.push(`Status: ${result.statusCode}`);
  if (result.contentType) lines.push(`Content-Type: ${result.contentType}`);
  lines.push(`Size  : ${formatBytes(result.html.length)} (${result.html.length.toLocaleString()} chars)`);
  lines.push("");

  const truncated = result.html.length > MAX_TEXT_OUTPUT_CHARS
    ? result.html.slice(0, MAX_TEXT_OUTPUT_CHARS)
      + `\n\n... (truncated at ${MAX_TEXT_OUTPUT_CHARS} characters — total ${result.html.length.toLocaleString()} chars)\n`
    : result.html;

  lines.push(truncated);
  return lines.join("\n");
}

/**
 * Formats extracted text for display.
 */
export function formatTextResult(result: FetchResult): string {
  const text = htmlToText(result.html);
  let output = "";

  const title = extractTitle(result.html);
  if (title && title !== "(no title found)" && !result.finalUrl.includes(title)) {
    output += `${title}\n`;
    output += "=".repeat(title.length) + "\n\n";
  }

  if (text.length > MAX_TEXT_OUTPUT_CHARS) {
    output += text.slice(0, MAX_TEXT_OUTPUT_CHARS);
    output += `\n\n... (truncated at ${MAX_TEXT_OUTPUT_CHARS} characters — total ${text.length.toLocaleString()} chars)\n`;
  } else {
    output += text;
  }

  return output;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Format byte count as human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
