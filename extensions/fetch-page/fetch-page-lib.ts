/**
 * Pure library code for fetching and parsing web pages.
 *
 * Two capabilities:
 *   1. Raw HTML — fetch a URL and return the unmodified HTML source.
 *   2. Text-only  — fetch a URL, strip all HTML tags & scripts/styles,
 *                  normalize whitespace, and return clean text content.
 *
 * Paging support:
 *   Both tools support an `offset` parameter. When output exceeds
 *   MAX_TEXT_OUTPUT_CHARS, a continuation marker is appended telling the
 *   agent to call again with `offset=N`. Page data is cached in-memory
 *   so offset-based chunks avoid re-fetching.
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

export interface CachedPage {
  result: FetchResult;
  /** Pre-computed plain text from htmlToText so offset chunks are cheap. */
  text: string;
}

export interface FetchPageOptions {
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Page cache — module-level, lives for the session lifetime
// ---------------------------------------------------------------------------

const pageCache = new Map<string, CachedPage>();

/** Store a fetched page in the cache so offset-based chunking works. */
function cachePage(normalizedUrl: string, result: FetchResult): void {
  pageCache.set(normalizedUrl, { result, text: htmlToText(result.html) });
}

/** Retrieve a previously cached page by its normalized URL. */
export function getCachedPage(normalizedUrl: string): CachedPage | undefined {
  return pageCache.get(normalizedUrl);
}

/** Clear the page cache (used in tests). */
export function clearCache(): void {
  pageCache.clear();
}

// ---------------------------------------------------------------------------
// Core fetch
// ---------------------------------------------------------------------------

/**
 * Fetches a URL and returns raw HTML + stores result in cache.
 * Follows up to 5 redirects automatically (fetch does this by default).
 */
export async function fetchPage(
  rawUrl: string,
  opts?: FetchPageOptions,
): Promise<FetchResult> {
  const url = normalizeUrl(rawUrl);

  // Serve from cache if available (offset-based continuation)
  const cached = pageCache.get(url);
  if (cached) return cached.result;

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

    const result: FetchResult = {
      statusCode: response.status,
      contentType: response.headers.get("content-type") ?? undefined,
      finalUrl: response.url,
      html,
    };

    cachePage(url, result);
    return result;
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

const BLOCK_TAGS = [
  "div", "p", "br", "hr", "section", "article", "aside",
  "header", "footer", "nav", "main", "ul", "ol", "li",
  "table", "tr", "td", "th", "thead", "tbody", "tfoot",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "pre", "figure", "figcaption",
  "details", "summary", "dl", "dt", "dd",
];

// Precompile block tag regexes (open, close, self-closing) at module load time.
// Each tag produces three patterns to avoid recompiling on every call.
const BLOCK_TAG_REGEXES = BLOCK_TAGS.flatMap((tag) => [
  new RegExp(`</${tag}>`, "gi"),   // close tag first (avoids partial matches)
  new RegExp(`<${tag}[^>]*/\\s*>`, "gi"),  // self-closing: <br/>, <hr/>
  new RegExp(`<${tag}[^>]*>`, "gi"),      // open tag
]);

const ENTITY_REGEXES = buildEntityRegexes();

/** Build [{ regex, char }] entries for named HTML entities.
 * &amp; is handled separately to avoid double-decoding.
 */
function buildEntityRegexes() {
  const map: Record<string, string> = {
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
  return Object.entries(map).map(([entity, char]) => ({
    regex: new RegExp(escapeRegExp(entity), "gi"),
    char,
  }));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decode all common HTML named/numeric entities in a string.
 * Handles &amp; last to avoid double-decoding.
 */
export function decodeHtmlEntities(text: string): string {
  // Named entities (non-&amp;)
  for (const { regex, char } of ENTITY_REGEXES) {
    text = text.replace(regex, char);
  }
  // &amp; → & last
  text = text.replace(/&amp;/gi, "&");
  // Numeric entities (&#65; and &#x41;)
  text = text.replace(/&#([0-9]+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
  return text;
}

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

  // Replace block-level tags with newlines (uses precompiled regexes)
  for (const regex of BLOCK_TAG_REGEXES) {
    text = text.replace(regex, "\n");
  }

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Remove remaining tags (e.g., <a>, <img>, etc.)
  text = text.replace(/<[^>]+>/g, "");

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
    return decodeHtmlEntities(match[1].trim());
  }
  // Fallback: try to extract from <meta> tags
  const metaTitleMatch = html.match(
    /<meta\s+(?:name|property)="(?:og:title|title)[^"]*"\s+content="([^"]*)"/i,
  );
  if (metaTitleMatch) return decodeHtmlEntities(metaTitleMatch[1].trim());
  return "(no title found)";
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Formats a fetch result for display as raw HTML.
 * When `offset` is provided, returns a chunk starting at that character position.
 */
export function formatHtmlResult(result: FetchResult, offset?: number): string {
  const start = offset ?? 0;
  const totalLen = result.html.length;
  const lines: string[] = [];

  if (start === 0) {
    lines.push(`URL : ${result.finalUrl}`);
    lines.push(`Status: ${result.statusCode}`);
    if (result.contentType) lines.push(`Content-Type: ${result.contentType}`);
    lines.push(`Size  : ${formatBytes(totalLen)} (${totalLen.toLocaleString()} chars)`);
    lines.push("");
  } else {
    lines.push(
      `[Continuation from offset ${start.toLocaleString()} — total ${totalLen.toLocaleString()} chars]`,
    );
    lines.push("");
  }

  const remaining = totalLen - start;
  if (remaining > MAX_TEXT_OUTPUT_CHARS) {
    const end = start + MAX_TEXT_OUTPUT_CHARS;
    lines.push(result.html.slice(start, end));
    lines.push("");
    lines.push(
      `... (truncated — ${end.toLocaleString()} / ${totalLen.toLocaleString()} chars — call again with offset=${end})`,
    );
  } else {
    lines.push(result.html.slice(start));
  }

  return lines.join("\n");
}

/**
 * Formats extracted text for display.
 * When `offset` is provided, returns a chunk starting at that character position.
 * When `cachedPage` is provided, uses pre-computed text to avoid re-processing.
 */
export function formatTextResult(
  result: FetchResult,
  offsetOrCached?: number | CachedPage,
): string {
  const cached: CachedPage | undefined =
    typeof offsetOrCached === "object" ? offsetOrCached : undefined;
  const offset: number = typeof offsetOrCached === "number" ? offsetOrCached : 0;

  const text = cached?.text ?? htmlToText(result.html);
  let output = "";

  if (offset === 0) {
    const title = extractTitle(result.html);
    if (title && title !== "(no title found)" && !result.finalUrl.includes(title)) {
      output += `${title}\n`;
      output += "=".repeat(title.length) + "\n\n";
    }
  } else {
    output += `[Continuation from offset ${offset.toLocaleString()} — total ${text.length.toLocaleString()} chars]\n\n`;
  }

  const remaining = text.length - offset;
  if (remaining > MAX_TEXT_OUTPUT_CHARS) {
    const end = offset + MAX_TEXT_OUTPUT_CHARS;
    output += text.slice(offset, end);
    output += `\n\n... (truncated — ${end.toLocaleString()} / ${text.length.toLocaleString()} chars — call again with offset=${end})\n`;
  } else {
    output += text.slice(offset);
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
