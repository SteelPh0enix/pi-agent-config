/**
 * Pure library code for SearXNG search integration.
 *
 * Extracted from searxng-search.ts so it can be unit-tested independently
 * without needing Pi's runtime (no ExtensionAPI, defineTool, etc.).
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
export const SEARXNG_BASE_URL = "https://search.steelph0enix.dev";
export const SEARCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Search API
// ---------------------------------------------------------------------------
export interface SearXNGSearchResult {
  title: string;
  url: string;
  content: string;
  engines?: string[];
  publishedDate?: string;
  [key: string]: unknown;
}

export interface SearXNGSearchParams {
  query: string;
  engines?: string;
  categories?: string;
}

/**
 * Fetches search results from the SearXNG instance.
 * Throws on HTTP errors and network failures.
 */
export async function searxngSearch(
  params: SearXNGSearchParams,
  opts?: { timeoutMs?: number },
): Promise<{ results: SearXNGSearchResult[]; totalEstimated: string }> {
  const { query } = params;
  const timeout = opts?.timeoutMs ?? SEARCH_TIMEOUT_MS;

  const url = new URL(`${SEARXNG_BASE_URL}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", "1");
  url.searchParams.set("safesearch", "0");
  // Do NOT set engines here — let SearXNG use its instance-level defaults.
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
      throw new Error(`SearXNG HTTP ${response.status}: ${response.statusText}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await response.json() as Record<string, any>;
    const results = Array.isArray(data["results"]) ? (data["results"] as unknown[]) : [];
    const estimated = String(
      data["number_of_results"] !== undefined
        ? data["number_of_results"]
        : results.length,
    );

    return { results: results as SearXNGSearchResult[], totalEstimated: estimated };
  } catch (err: unknown) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`SearXNG search failed: ${message}`);
  }
}

/**
 * Formats search results into a human-readable multi-line string.
 */
export function formatResults(
  query: string,
  results: SearXNGSearchResult[],
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
  results: SearXNGSearchResult[],
): string {
  const items = results.slice(0, 10).map((r, i) => {
    const title = r.title ?? "(no title)";
    const imgSrc = (r.img_src as string) ?? "";
    const srcUrl = r.url;
    return `${i + 1}. ${title}\n   Image: ${imgSrc || "N/A"}\n   Source: ${srcUrl}`;
  });

  return `Image search results for "${query}":\n\n${items.join("\n\n")}\n\nShowing top ${Math.min(results.length, 10)} of ${results.length} images.`;
}
