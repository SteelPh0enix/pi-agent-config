/**
 * Pure library code for web search integration.
 *
 * Handles all HTTP calls and result formatting independently of Pi's runtime
 * (no ExtensionAPI, defineTool, etc.).
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
/**
 * Returns the search backend base URL, read lazily so tests can set the
 * environment variable before the first access.
 */
export function getSearchBaseUrl(): string {
  const instance = process.env.PI_EXTENSION_SEARXNG_INSTANCE;
  if (!instance) {
    throw new Error(
      "PI_EXTENSION_SEARXNG_INSTANCE environment variable is not set. "+
        "Set it to your search backend URL.",
    );
  }
  return instance.replace(/\/+$/, ""); // strip trailing slash
}

/** Search backend base URL, read lazily from PI_EXTENSION_SEARXNG_INSTANCE env var. */
export const SEARCH_BASE_URL = new Proxy({} as string, {
  get(_target: object, prop: string | symbol) {
    if (prop === "toString" || prop === Symbol.toPrimitive) {
      return () => getSearchBaseUrl();
    }
    if (prop === Symbol.toStringTag) return "String";
    const val = getSearchBaseUrl();
    const result = (val as any)[prop];
    return typeof result === "function" ? result.bind(val) : result;
  },
}) as unknown as string;
export const SEARCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Search API
// ---------------------------------------------------------------------------
export interface SearchResult {
  title: string;
  url: string;
  content: string;
  engines?: string[];
  publishedDate?: string;
  [key: string]: unknown;
}

export interface SearchParams {
  query: string;
  engines?: string;
  categories?: string;
}

/**
 * Fetches search results from the web search backend.
 * Throws on HTTP errors and network failures.
 */
export async function webSearch(
  params: SearchParams,
  opts?: { timeoutMs?: number },
): Promise<{ results: SearchResult[]; totalEstimated: string }> {
  const { query } = params;
  const timeout = opts?.timeoutMs ?? SEARCH_TIMEOUT_MS;

  const url = new URL(`${SEARCH_BASE_URL}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", "1");
  url.searchParams.set("safesearch", "0");
  if (params.engines) {
    url.searchParams.set("engines", params.engines);
  }
  if (params.categories) {
    url.searchParams.set("categories", params.categories);
  } else {
    url.searchParams.set("categories", "general");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await response.json() as Record<string, any>;
    const results = Array.isArray(data["results"]) ? (data["results"] as unknown[]) : [];

    // number_of_results can be 0 for some categories (news, images) even when
    // results are returned. Use the actual result count as a lower bound.
    const rawTotal = data["number_of_results"] !== undefined
      ? Number(data["number_of_results"])
      : NaN;
    const estimated = String(
      !Number.isFinite(rawTotal) || rawTotal < results.length
        ? results.length
        : rawTotal,
    );

    return { results: results as SearchResult[], totalEstimated: estimated };
  } catch (err: unknown) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Search failed: ${message}`);
  }
}

/**
 * Formats search results into a human-readable multi-line string.
 */
export function formatResults(
  query: string,
  results: SearchResult[],
  totalEstimated: string,
): string {
  const items = results.slice(0, 10).map((r, i) => {
    const title = r.title ?? "(no title)";
    const rurl = r.url;
    const content = r.content;
    const engines = Array.isArray(r.engines) ? (r.engines as string[]).join(", ") : "";
    const publishedDate = r.publishedDate
      ? ` | Published: ${String(r.publishedDate)}`
      : "";

    return [
      `${i + 1}. ${title}`,
      `   ${rurl}`,
      content ? `   ${content.slice(0, 280)}${content.length > 280 ? "..." : ""}` : "",
      engines || publishedDate ? `   [${engines}${publishedDate}]` : "",
    ].join("\n");
  });

  return [
    `Search results for "${query}" (estimated total: ${totalEstimated}):`,
    "",
    ...items,
    "",
    `Showing top ${Math.min(results.length, 10)} of ${results.length} results.`,
  ].join("\n");
}

/**
 * Formats search results into image-specific output with img_src.
 */
export function formatImageResults(
  query: string,
  results: SearchResult[],
): string {
  const items = results.slice(0, 10).map((r, i) => {
    const title = r.title ?? "(no title)";
    const imgSrc = (r.img_src as string) ?? "";
    const srcUrl = r.url;
    return `${i + 1}. ${title}\n   Image: ${imgSrc || "N/A"}\n   Source: ${srcUrl}`;
  });

  return `Image search results for "${query}":\n\n${items.join("\n\n")}\n\nShowing top ${Math.min(results.length, 10)} of ${results.length} images.`;
}
