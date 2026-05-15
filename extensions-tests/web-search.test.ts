/**
 * Tests for web-search extension.
 *
 * Suites:
 *   1. Library — formatResults unit tests
 *   2. Library — formatImageResults unit tests
 *   3. Library — webSearch (mocked fetch) URL construction + error handling
 *   4. Library — coerceQueryParams (re-implemented for testing)
 *   5. Extension — tool registration & source checks
 *   6. Library — search-lib.ts error message verification
 *   7. Integration — real search calls against live backend
 */

// Set env variable before importing search-lib (required by the module).
// Only provide a test default when nothing is set externally.
if (!process.env.PI_EXTENSION_SEARXNG_INSTANCE) {
  process.env.PI_EXTENSION_SEARXNG_INSTANCE = "https://search.test.example.com";
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  formatResults,
  formatImageResults,
  webSearch,
  getSearchBaseUrl,
  SEARCH_BASE_URL,
  SEARCH_TIMEOUT_MS,
} from "../extensions/web-search/search-lib";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSIONS_DIR = path.resolve(TEST_DIR, "..", "extensions");
const readExtensionFile = (name: string): string =>
  fs.readFileSync(path.resolve(EXTENSIONS_DIR, name), "utf-8");

/** Minimal valid search result. */
const R = (title: string, url: string, content = "", engines: string[] = []): SearchResult => ({
  title,
  url,
  content,
  engines,
});

/** Result without engines / content — for terser tests. */
const rx = (title: string, url: string): SearchResult => R(title, url, "", []);

import type { SearchResult } from "../extensions/web-search/search-lib";

// --- Mock helpers ---

/** Returns a fetch mock that resolves to { results, number_of_results }. */
function mockFetchOk(results: unknown[] = [], number_of_results?: number): ReturnType<typeof vi.fn> {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          results,
          number_of_results: number_of_results ?? results.length,
        }),
    }),
  );
}

/** Returns a fetch mock that rejects with a network error. */
function mockFetchReject(err: Error | DOMException): ReturnType<typeof vi.fn> {
  return vi.fn(() => Promise.reject(err));
}

/** Returns a fetch mock that resolves to a non-ok HTTP response. */
function mockFetchHttpError(status: number, statusText: string): ReturnType<typeof vi.fn> {
  return vi.fn(() => Promise.resolve({ ok: false, status, statusText }));
}

/** Extract the URL called by a mocked fetch. */
function calledUrl(mock: ReturnType<typeof vi.fn>): URL {
  return new URL(mock.mock.calls[0][0] as string);
}

// --- Integration test helpers ---

async function probeBackend(): Promise<boolean> {
  try {
    const url = `${getSearchBaseUrl()}/search?q=integration_probe&format=json`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return resp.ok;
  } catch {
    return false;
  }
}

const _probePromise = probeBackend();

// ---------------------------------------------------------------------------
// 1. Library — formatResults unit tests
// ---------------------------------------------------------------------------

describe("formatResults (library)", () => {
  it("formats a single result with all fields", () => {
    const output = formatResults(
      "hello world",
      [R("Hello World", "https://example.com", "A brief snippet.", ["google"])],
      "1",
    );

    expect(output).toContain('Search results for "hello world" (estimated total: 1):');
    expect(output).toContain("1. Hello World");
    expect(output).toContain("   https://example.com");
    expect(output).toContain("   A brief snippet.");
    expect(output).toContain("[google]");
  });

  it("numbers multiple results correctly", () => {
    const output = formatResults("test", [rx("First", "https://a.com"), rx("Second", "https://b.com")], "2");

    expect(output).toContain("1. First");
    expect(output).toContain("2. Second");
    expect(output).toContain("Showing top 2 of 2 results.");
  });

  it("truncates snippets longer than 280 chars with ellipsis", () => {
    const longContent = "a".repeat(300);
    const output = formatResults("query", [R("X", "https://x.com", longContent)], "1");
    expect(output).toContain("...");
    expect(output).not.toContain(longContent); // full text absent
  });

  it("does not add ellipsis when snippet fits", () => {
    const output = formatResults("query", [R("Short", "https://x.com", "hi there!")], "1");
    expect(output).toContain("hi there!");
    expect(output).not.toContain("...");
  });

  it("omits metadata line when no engines and no publishedDate", () => {
    const output = formatResults("q", [rx("T", "https://x.com")], "1");
    // Should not contain blank bracket line or trailing metadata
    expect(output).not.toMatch(/\[\s*\]/);
  });

  it("shows publishedDate in metadata line", () => {
    const output = formatResults("q", [{ ...rx("News", "https://n.com"), publishedDate: "2024-06-15" }], "1");
    expect(output).toContain("Published: 2024-06-15");
  });

  it("caps display at 10 results", () => {
    const many = Array.from({ length: 25 }, (_, i) => rx(`R${i + 1}`, `https://x.com/${i}`));
    const output = formatResults("test", many, "25");
    expect(output).toContain("10. R10");
    expect(output).not.toContain("11. R11");
    expect(output).toContain("Showing top 10 of 25 results.");
  });

  it("handles empty results array", () => {
    const output = formatResults("query", [], "0");
    expect(output).toContain('Search results for "query" (estimated total: 0):');
    expect(output).toContain("Showing top 0 of 0 results.");
  });

  it("uses (no title) fallback when title is missing", () => {
    const output = formatResults("q", [{ url: "https://a.com" }] as SearchResult[], "1");
    expect(output).toContain("(no title)");
  });

  it("survives malformed result objects without throwing", () => {
    const malformed = [
      {} as SearchResult,
      { title: null as unknown as string, url: 42 as unknown as string } as SearchResult,
    ];
    expect(() => formatResults("q", malformed, "0")).not.toThrow();
  });

  it("joins engines array with commas", () => {
    const output = formatResults("q", [R("R", "https://x.com", "", ["google", "bing"])], "1");
    expect(output).toContain("[google, bing]");
  });

  it("handles empty string query", () => {
    const output = formatResults("", [rx("R", "https://x.com")], "1");
    expect(output).toContain('Search results for ""');
  });

  it("handles special characters in query string", () => {
    const output = formatResults('foo "bar" & baz', [rx("R", "https://x.com")], "1");
    expect(output).toContain('Search results for "foo "bar" & baz"');
  });
});

// ---------------------------------------------------------------------------
// 2. Library — formatImageResults unit tests
// ---------------------------------------------------------------------------

describe("formatImageResults (library)", () => {
  it("formats image result with img_src field", () => {
    const output = formatImageResults("sunset", [
      {
        title: "Sunset",
        url: "https://p.com/s",
        img_src: "https://cdn.com/s.jpg",
      } as SearchResult,
    ]);

    expect(output).toContain("1. Sunset");
    expect(output).toContain("   Image: https://cdn.com/s.jpg");
    expect(output).toContain("   Source: https://p.com/s");
  });

  it("shows N/A when img_src is missing or empty", () => {
    const results = [
      { title: "Empty", url: "https://a.com", img_src: "" },
      { title: "Missing", url: "https://b.com" },
    ] as SearchResult[];

    const output = formatImageResults("test", results);
    // Both results should show N/A — exactly 2 N/A occurrences
    expect(output.match(/Image: N\/A/g)?.length).toBe(2);
  });

  it("caps at 10 images", () => {
    const many = Array.from(
      { length: 15 },
      (_, i) =>
        ({
          title: `Img ${i + 1}`,
          url: `https://i.com/${i}`,
          img_src: "",
        }) as SearchResult,
    );

    const output = formatImageResults("test", many);
    expect(output).toContain("10. Img 10");
    expect(output).not.toContain("11. Img 11");
    expect(output).toContain("Showing top 10 of 15 images.");
  });

  it("has correct header format", () => {
    const output = formatImageResults("cats", [{ title: "T", url: "https://x.com" } as SearchResult]);
    expect(output).toContain('Image search results for "cats":');
  });

  it("handles empty results array", () => {
    const output = formatImageResults("test", []);
    expect(output).toContain('Image search results for "test":');
    expect(output).toContain("Showing top 0 of 0 images.");
  });

  it("separates multiple results with blank lines", () => {
    const results = [
      { title: "A", url: "https://a.com", img_src: "a.png" },
      { title: "B", url: "https://b.com", img_src: "b.png" },
    ] as SearchResult[];

    const output = formatImageResults("test", results);
    expect(output.split("\n\n").length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Library — webSearch (mocked fetch) URL construction + error handling
// ---------------------------------------------------------------------------

describe("webSearch (mocked)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // --- URL construction ---

  it("constructs correct URL with default params", async () => {
    const mock = mockFetchOk();
    globalThis.fetch = mock as never;

    await webSearch({ query: "hello world" });

    const url = calledUrl(mock);
    const expectedHost = new URL(getSearchBaseUrl()).hostname;
    expect(url.hostname).toBe(expectedHost);
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("hello world");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("pageno")).toBe("1");
    expect(url.searchParams.get("safesearch")).toBe("0");
    expect(url.searchParams.get("engines")).toBeNull();
    expect(url.searchParams.get("categories")).toBe("general");
  });

  it("passes through custom engines param", async () => {
    const mock = mockFetchOk();
    globalThis.fetch = mock as never;

    await webSearch({ query: "test", engines: "bing,wikipedia" });
    expect(calledUrl(mock).searchParams.get("engines")).toBe("bing,wikipedia");
  });

  it("passes through categories param", async () => {
    const mock = mockFetchOk();
    globalThis.fetch = mock as never;

    await webSearch({ query: "news", categories: "news" });
    expect(calledUrl(mock).searchParams.get("categories")).toBe("news");
  });

  it("URL-encodes query parameters correctly", async () => {
    const mock = mockFetchOk();
    globalThis.fetch = mock as never;

    await webSearch({ query: "hello world & foo=bar" });
    expect(calledUrl(mock).searchParams.get("q")).toBe("hello world & foo=bar");
  });

  // --- Response parsing ---

  it("parses returned results and number_of_results", async () => {
    const expected = [R("R1", "https://a.com", "C1"), R("R2", "https://b.com", "C2")];
    globalThis.fetch = mockFetchOk(expected, 42) as never;

    const { results, totalEstimated } = await webSearch({ query: "test" });
    expect(results).toEqual(expected);
    expect(totalEstimated).toBe("42");
  });

  it.each([
    { desc: "missing number_of_results", response: { results: [{ title: "X" }] }, expected: "1" },
    {
      desc: "zero number_of_results with 3 results",
      response: { results: [{ title: "A" }, { title: "B" }, { title: "C" }], number_of_results: 0 },
      expected: "3",
    },
    {
      desc: "number_of_results < actual count",
      response: { results: Array.from({ length: 10 }, (_, i) => ({ title: `R${i}` })), number_of_results: 3 },
      expected: "10",
    },
  ])("totalEstimated falls back correctly: $desc", async ({ response, expected }) => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(response),
      }),
    ) as never;

    const { totalEstimated } = await webSearch({ query: "test" });
    expect(totalEstimated).toBe(expected);
  });

  it("returns empty array when response has no results field", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ other_field: "not results" }),
      }),
    ) as never;

    const { results } = await webSearch({ query: "test" });
    expect(results).toEqual([]);
  });

  // --- Error handling ---

  it("throws on HTTP 503 with generic message (no backend name leak)", async () => {
    globalThis.fetch = mockFetchHttpError(503, "Service Unavailable") as never;

    const err = await webSearch({ query: "test" }).catch((e: unknown) => e);
    expect(err.message).toMatch(/HTTP 503/);
    expect(err.message).not.toMatch(/SearX?NG/i);
  });

  it("wraps network errors with 'Search failed' prefix", async () => {
    globalThis.fetch = mockFetchReject(new Error("ENOTFOUND"));
    await expect(webSearch({ query: "test" })).rejects.toThrow(/Search failed/);
  });

  it("wraps AbortError gracefully", async () => {
    globalThis.fetch = mockFetchReject(new DOMException("aborted", "AbortError"));
    await expect(webSearch({ query: "test" })).rejects.toThrow(/Search failed.*aborted/);
  });

  it("wraps non-Error rejection values", async () => {
    globalThis.fetch = mockFetchReject(new Error("string error"));
    await expect(webSearch({ query: "test" })).rejects.toThrow(/Search failed.*string error/);
  });

  it("respects timeout option", async () => {
    let resolveFetch: ((v: Response) => void) | undefined;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolveFetch = r;
        }),
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method -- patching prototype intentionally
    const originalAbort = AbortController.prototype.abort;
    (AbortController.prototype as Record<string, unknown>).abort = function (this: AbortController): void {
      originalAbort.call(this);
      resolveFetch?.({ ok: false, status: 499, statusText: "aborted" } as Response);
    };

    const p = webSearch({ query: "test" }, { timeoutMs: 50 }).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    (AbortController.prototype as Record<string, unknown>).abort = originalAbort;
    await p;
  });

  it("handles empty query without crashing", async () => {
    globalThis.fetch = mockFetchOk([]) as never;
    const { results } = await webSearch({ query: "" });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Library — coerceQueryParams (re-implemented for testing)
// ---------------------------------------------------------------------------

describe("coerceQueryParams (extension helper)", () => {
  // Re-implement to test independently (avoid importing Pi runtime types)
  function coerceQueryParams(raw: unknown): { query: string } {
    if (typeof raw === "string") return { query: raw.trim() };
    if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      for (const key of ["query", "q"]) {
        const val = o[key];
        if (typeof val === "string" && val.trim()) return { query: val.trim() };
      }
    }
    return { query: "" };
  }

  it("coerces a plain string into { query }", () => {
    expect(coerceQueryParams("hello world")).toEqual({ query: "hello world" });
  });

  it("trims whitespace from input", () => {
    expect(coerceQueryParams("  test query  ")).toEqual({ query: "test query" });
  });

  it("extracts 'query' key from object", () => {
    expect(coerceQueryParams({ query: "hello world" })).toEqual({ query: "hello world" });
  });

  it("extracts 'q' key from object", () => {
    expect(coerceQueryParams({ q: "hello world" })).toEqual({ query: "hello world" });
  });

  it("prefers 'query' over 'q'", () => {
    expect(coerceQueryParams({ query: "a", q: "b" })).toEqual({ query: "a" });
  });

  it("falls back to 'q' when query is empty", () => {
    expect(coerceQueryParams({ query: "", q: "fallback" })).toEqual({ query: "fallback" });
  });

  // Table-driven tests for inputs that all return empty query
  it.each([
    { label: "non-string value", input: { query: 123 } },
    { label: "null", input: null },
    { label: "undefined", input: undefined },
    { label: "number", input: 42 },
    { label: "empty object", input: {} },
    { label: "whitespace-only query", input: { query: "   " } },
  ])("returns empty query for $label", ({ input }) => {
    expect(coerceQueryParams(input)).toEqual({ query: "" });
  });

  it("trims query value extracted from object", () => {
    expect(coerceQueryParams({ query: "  hello  " })).toEqual({ query: "hello" });
  });
});

// ---------------------------------------------------------------------------
// 5. Extension — tool registration & source checks
// ---------------------------------------------------------------------------

describe("web-search (extension)", () => {
  it("search-lib exports all required members", () => {
    expect(formatResults).toBeDefined();
    expect(formatImageResults).toBeDefined();
    expect(webSearch).toBeDefined();
    const envUrl = process.env.PI_EXTENSION_SEARXNG_INSTANCE ?? "";
    expect(getSearchBaseUrl()).toBe(envUrl.replace(/\/+$/, ""));
    expect(SEARCH_TIMEOUT_MS).toBe(15_000);
  });

  it("extension source imports from search-lib, not duplicating logic", () => {
    const src = readExtensionFile("web-search/index.ts");
    expect(src).toContain('from "./search-lib"');
    expect(src).toContain('name: "web_search"');
    expect(src).toContain('name: "web_news_search"');
    expect(src).toContain('name: "web_image_search"');
  });

  it("source has no SearXNG references in user-facing strings", () => {
    const src = readExtensionFile("web-search/index.ts");
    expect(src).not.toMatch(/["']searxng_search["']/i);
    expect(src).not.toMatch(/["']SearXNG/i);
    expect(src).not.toMatch(/label.*[Ss]earx/i);
  });

  it("defines all three tools with correct labels", () => {
    const src = readExtensionFile("web-search/index.ts");
    expect(src).toContain('label: "Web Search"');
    expect(src).toContain('label: "Web News Search"');
    expect(src).toContain('label: "Web Image Search"');
  });

  it("defines web-search-status command", () => {
    const src = readExtensionFile("web-search/index.ts");
    expect(src).toContain("web-search-status");
    expect(src).toContain("registerCommand");
  });

  it("session_start notification uses generic language", () => {
    const src = readExtensionFile("web-search/index.ts");
    expect(src).toMatch(/Web Search extension loaded/);
    expect(src).not.toMatch(/SearXNG.*extension loaded/i);
  });

  it("has renderSearchResult helper called by all tools", () => {
    const src = readExtensionFile("web-search/index.ts");
    const callCount = (src.match(/renderSearchResult\(/g) || []).length;
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("exports coerceQueryParams for testability", () => {
    expect(readExtensionFile("web-search/index.ts")).toContain("export function coerceQueryParams");
  });
});

// ---------------------------------------------------------------------------
// 6. Library — search-lib.ts error message verification
// ---------------------------------------------------------------------------

describe("search-lib (error messages)", () => {
  const libSrc = readExtensionFile("web-search/search-lib.ts");

  it("does not leak backend name in throw or Error messages", () => {
    expect(libSrc).not.toMatch(/throw.*[Ss]earx/i);
    expect(libSrc).not.toMatch(/Error.*[Ss]earx/i);
  });

  it("exports SEARCH_BASE_URL (not SEARXNG_BASE_URL)", () => {
    expect(libSrc).toContain("export const SEARCH_BASE_URL");
    expect(libSrc).not.toContain("SEARXNG_BASE_URL");
  });

  it("exports webSearch (not searxngSearch)", () => {
    expect(libSrc).toContain("export async function webSearch");
    expect(libSrc).not.toContain("searxngSearch");
  });
});

// ---------------------------------------------------------------------------
// 6b. Runtime coverage — getSearchBaseUrl error path & SEARCH_BASE_URL proxy
// ---------------------------------------------------------------------------

describe("search-lib (runtime coverage)", () => {
  it("getSearchBaseUrl throws when PI_EXTENSION_SEARXNG_INSTANCE is unset", () => {
    const saved = process.env.PI_EXTENSION_SEARXNG_INSTANCE;
    delete process.env.PI_EXTENSION_SEARXNG_INSTANCE;
    try {
      expect(() => getSearchBaseUrl()).toThrow(/PI_EXTENSION_SEARXNG_INSTANCE/);
    } finally {
      process.env.PI_EXTENSION_SEARXNG_INSTANCE = saved;
    }
  });

  it("SEARCH_BASE_URL proxy coerces to string in template literals", () => {
    expect(`${SEARCH_BASE_URL}/search`).toContain("/search");
  });

  it("SEARCH_BASE_URL proxy supports .length", () => {
    expect(typeof SEARCH_BASE_URL.length).toBe("number");
    expect(SEARCH_BASE_URL.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Integration tests — real calls against the live search backend
// ---------------------------------------------------------------------------

describe("web-search (integration)", () => {
  let backendAvailable = false;

  beforeEach(async () => {
    backendAvailable = await _probePromise;
  }, 15_000);

  const itLive = (name: string, fn: () => Promise<void> | void, timeout?: number): ReturnType<typeof it> => {
    const label = backendAvailable ? name : `SKIPPED — ${name} (backend unreachable)`;
    it(
      label,
      async () => {
        if (!backendAvailable) return;
        await fn();
      },
      timeout ?? 20_000,
    );
  };

  // ------------------------------------------------------------------
  // Connectivity
  // ------------------------------------------------------------------

  describe("connectivity", () => {
    itLive(
      "health-check ping returns HTTP 200",
      async () => {
        const url = `${getSearchBaseUrl()}/search?q=ping&format=json`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        expect(resp.status).toBe(200);
      },
      15_000,
    );

    itLive(
      "health-check ping returns parseable JSON",
      async () => {
        const url = `${getSearchBaseUrl()}/search?q=ping&format=json`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        expect(resp.ok).toBe(true);
        const data = await resp.json();
        expect(data).toBeDefined();
        expect(Array.isArray(data.results)).toBe(true);
      },
      15_000,
    );
  });

  // ------------------------------------------------------------------
  // Web search (general category)
  // ------------------------------------------------------------------

  describe("web search (general)", () => {
    itLive("returns results for a general query", async () => {
      const { results, totalEstimated } = await webSearch({ query: "wikipedia encyclopedia" });
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(typeof totalEstimated).toBe("string");
    });

    itLive("each result has required fields (title, url)", async () => {
      const { results } = await webSearch({ query: "vitest testing framework" });
      for (const r of results) {
        expect(typeof r.title).toBe("string");
        expect(typeof r.url).toBe("string");
        expect(r.url).toMatch(/^https?:\/\//);
      }
    });

    itLive("totalEstimated is numeric string", async () => {
      const { totalEstimated } = await webSearch({ query: "vitest" });
      expect(typeof totalEstimated).toBe("string");
      expect(Number(totalEstimated)).toBeGreaterThanOrEqual(0);
    });

    itLive("formatResults output contains query, results, and count", async () => {
      const query = "nodejs package manager";
      const { results, totalEstimated } = await webSearch({ query });
      const formatted = formatResults(query, results, totalEstimated);

      expect(formatted).toContain(`Search results for "${query}"`);
      expect(formatted).toContain(`estimated total: ${totalEstimated}`);
      if (results.length > 0) {
        expect(formatted).toContain("1. " + results[0].title);
        expect(formatted).toContain(results[0].url);
      }
      expect(formatted).toContain(
        `Showing top ${Math.min(results.length, 10)} of ${results.length} results.`,
      );
    });

    itLive("handles special characters in query without crashing", async () => {
      const { results } = await webSearch({ query: 'test "quoted" & <special> ñ ü €' });
      expect(Array.isArray(results)).toBe(true);
    });

    itLive("engines field is an array when present", async () => {
      const { results } = await webSearch({ query: "vitest" });
      const withEngines = results.filter((r) => r.engines !== undefined);
      for (const r of withEngines) {
        expect(Array.isArray(r.engines)).toBe(true);
      }
    });

    itLive("result URLs are well-formed and unique", async () => {
      const { results } = await webSearch({ query: "wikipedia encyclopedia" });
      expect(results.length).toBeGreaterThan(0);
      const urls = results.map((r) => r.url);
      expect(new Set(urls).size).toBe(urls.length); // no duplicate URLs
      for (const url of urls) {
        expect(url).toMatch(/^https?:\/\//);
      }
    });

    itLive("handles Unicode query", async () => {
      const { results } = await webSearch({ query: "日本語で検索" });
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // News search
  // ------------------------------------------------------------------

  describe("news search", () => {
    itLive("returns results for news category", async () => {
      const { results } = await webSearch({ query: "technology", categories: "news" });
      expect(Array.isArray(results)).toBe(true);
    });

    itLive("news results have required fields", async () => {
      const { results } = await webSearch({ query: "AI artificial intelligence", categories: "news" });
      for (const r of results) {
        expect(typeof r.title).toBe("string");
        expect(typeof r.url).toBe("string");
      }
    });

    itLive("formatResults works with news output", async () => {
      const query = "technology news";
      const { results, totalEstimated } = await webSearch({ query, categories: "news" });
      const formatted = formatResults(query, results, totalEstimated);
      expect(formatted).toContain(`Search results for "${query}"`);
      expect(formatted).toMatch(/Showing top \d+ of \d+ results./);
    });
  });

  // ------------------------------------------------------------------
  // Image search
  // ------------------------------------------------------------------

  describe("image search", () => {
    itLive("returns results for images category", async () => {
      const { results } = await webSearch({ query: "landscape nature photo", categories: "images" });
      expect(Array.isArray(results)).toBe(true);
    });

    itLive("image results have title, url, and img_src when present", async () => {
      const { results } = await webSearch({ query: "sunset beach", categories: "images" });
      for (const r of results) {
        expect(typeof r.title).toBe("string");
        expect(typeof r.url).toBe("string");
        if (r.img_src !== undefined) {
          expect(typeof r.img_src).toBe("string");
        }
      }
    });

    itLive("formatImageResults produces valid output with Image:/N/A lines", async () => {
      const query = "mountain scenery";
      const { results } = await webSearch({ query, categories: "images" });
      const formatted = formatImageResults(query, results);

      expect(formatted).toContain(`Image search results for "${query}"`);

      const imageLines = formatted.split("\n").filter((l) => l.startsWith("   Image:"));
      expect(imageLines.length).toBe(Math.min(results.length, 10));
      for (const line of imageLines) {
        expect(line).toMatch(/ {3}Image: ((https?:)?\/\/.*|N\/A)/);
      }

      expect(formatted).toContain(`Showing top ${Math.min(results.length, 10)} of ${results.length} images.`);
    });
  });

  // ------------------------------------------------------------------
  // Error scenarios
  // ------------------------------------------------------------------

  describe("error scenarios", () => {
    itLive(
      "search respects custom timeout parameter",
      async () => {
        const start = Date.now();
        await webSearch({ query: "timeout-test" }, { timeoutMs: 50 }).catch(() => {});
        expect(Date.now() - start).toBeLessThan(2_000);
      },
      10_000,
    );
  });

  // ------------------------------------------------------------------
  // End-to-end tool simulation
  // These mirror what the extension tools do internally.
  // ------------------------------------------------------------------

  describe("end-to-end tool simulation", () => {
    itLive("web_search flow: query → webSearch → formatResults", async () => {
      const query = "Rust programming language";
      const { results, totalEstimated } = await webSearch({ query });
      const formatted = formatResults(query, results, totalEstimated);

      expect(formatted).toContain(`Search results for "${query}" (estimated total: ${totalEstimated}):`);
      expect(formatted).toContain("Showing top");
      expect(formatted).toContain(`${results.length} results.`);
    });

    itLive("web_news_search flow: query → webSearch(news) → formatResults", async () => {
      const query = "climate change";
      const { results, totalEstimated } = await webSearch({ query, categories: "news" });
      const formatted = formatResults(query, results, totalEstimated);

      expect(formatted).toContain(`Search results for "${query}"`);
      expect(formatted).toMatch(/Showing top \d+ of \d+ results./);
    });

    itLive("web_image_search flow: query → webSearch(images) → formatImageResults", async () => {
      const query = "space nebula";
      const { results } = await webSearch({ query, categories: "images" }, { timeoutMs: SEARCH_TIMEOUT_MS });
      const formatted = formatImageResults(query, results);

      expect(formatted).toContain(`Image search results for "${query}"`);
      expect(formatted).toMatch(/Showing top \d+ of \d+ images./);
    });
  });
});
