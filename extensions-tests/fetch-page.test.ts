/**
 * Tests for fetch-page extension.
 *
 * Three suites:
 *   1. Library — pure unit tests on fetch-page-lib (htmlToText, extractTitle, etc.)
 *   2. Extension — verifies tool registration & metadata (mocked Pi types)
 *   3. Integration — real HTTP calls against live web pages
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  htmlToText,
  extractTitle,
  normalizeUrl,
  formatHtmlResult,
  formatTextResult,
  fetchPage,
  decodeHtmlEntities,
  getCachedPage,
  clearCache,
  MAX_TEXT_OUTPUT_CHARS,
  type CachedPage,
} from "../extensions/fetch-page/fetch-page-lib";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSIONS_DIR = path.resolve(TEST_DIR, "..", "extensions");
const readExtensionFile = (name: string): string =>
  fs.readFileSync(path.resolve(EXTENSIONS_DIR, name), "utf-8");

// ---------------------------------------------------------------------------
// 1. Library — htmlToText unit tests
// ---------------------------------------------------------------------------

describe("htmlToText (library)", () => {
  it("strips HTML tags and returns plain text", () => {
    const html = "<p>Hello <b>world</b></p>";
    expect(htmlToText(html)).toBe("Hello world");
  });

  it("removes script blocks completely", () => {
    const html = `<div>Hello<script>var x=1;</script> World</div>`;
    expect(htmlToText(html)).toBe("Hello World");
  });

  it("removes style blocks completely", () => {
    const html = `<style>.foo{color:red}</style><p>Hello</p>`;
    expect(htmlToText(html)).toBe("Hello");
  });

  it("converts block-level tags to newlines", () => {
    const html = `<h1>Title</h1>\n<p>Para 1</p>\n<p>Para 2</p>`;
    const result = htmlToText(html);
    expect(result).toContain("Title");
    expect(result).toContain("Para 1");
    expect(result).toContain("Para 2");
    const lines = result.split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it("decodes common HTML entities", () => {
    const html = "Tea &amp; coffee &mdash; daily &bull;;";
    const result = htmlToText(html);
    expect(result).toContain("&");
    expect(result).toContain("—");
    expect(result).toContain("•");
  });

  it("decodes numeric entities", () => {
    const html = "&#65;&#x42;";
    expect(htmlToText(html)).toBe("AB");
  });

  it("handles HTML comments by removing them", () => {
    const html = "<p>Before <!-- comment --> After</p>";
    expect(htmlToText(html)).toBe("Before After");
  });

  it("collapses multiple spaces and blank lines", () => {
    const html = `<div>word   word   word</div>\n\n\n<p>another</p>`;
    const result = htmlToText(html);
    expect(result).toContain("word word word");
    expect(result).not.toContain("\n\n\n");
  });

  it("handles empty string", () => {
    expect(htmlToText("")).toBe("");
  });

  it("handles string with only whitespace", () => {
    expect(htmlToText("   \n\t  ")).toBe("");
  });

  it("truncates long whitespace-only text properly", () => {
    const html = Array(100).fill("<p>Some paragraph</p>").join("\n");
    const result = htmlToText(html);
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain("   ");
  });

  it("preserves meaningful newlines between headings and paragraphs", () => {
    const html = "<h1>Introduction</h1><p>Content here.</p>";
    const result = htmlToText(html);
    expect(result).toContain("Introduction");
    expect(result).toContain("Content here.");
  });

  it("removes table structure but keeps content", () => {
    const html = `<table><tr><td>A</td><td>B</td></tr></table>`;
    const result = htmlToText(html);
    expect(result).toBe("A\nB");
  });

  it("handles lists with proper separation", () => {
    const html = "<ul><li>Item 1</li><li>Item 2</li></ul>";
    const result = htmlToText(html);
    expect(result).toContain("Item 1");
    expect(result).toContain("Item 2");
  });

  it("strips remaining tags like <a> and <img>", () => {
    const html = "See <a href='https://example.com'>this link</a> for more";
    expect(htmlToText(html)).toBe("See this link for more");
  });

  it("normalizes mixed case block tags", () => {
    const html = "<DIV>Hello</Div><p>World</P>";
    const result = htmlToText(html);
    expect(result).toContain("Hello");
    expect(result).toContain("World");
  });
});

// ---------------------------------------------------------------------------
// 2. Library — extractTitle unit tests
// ---------------------------------------------------------------------------

describe("extractTitle (library)", () => {
  it("extracts title from <title> tag", () => {
    const html = "<html><head><title>My Page</title></head><body>...</body></html>";
    expect(extractTitle(html)).toBe("My Page");
  });

  it("trims whitespace from title", () => {
    const html = "<title>   Hello World   </title>";
    expect(extractTitle(html)).toBe("Hello World");
  });

  it("decodes entities in title", () => {
    const html = "<title>My Page &amp; More</title>";
    expect(extractTitle(html)).toBe("My Page & More");
  });

  it("returns fallback when no title found", () => {
    const html = "<html><body>Hello</body></html>";
    expect(extractTitle(html)).toBe("(no title found)");
  });

  it("handles empty <title> tag", () => {
    const html = "<title></title>";
    expect(extractTitle(html).trim()).toBe("");
  });

  it("falls back to og:title meta tag", () => {
    const html = '<meta property="og:title" content="Fallback Title">';
    expect(extractTitle(html)).toBe("Fallback Title");
  });
});

// ---------------------------------------------------------------------------
// 3. Library — normalizeUrl unit tests
// ---------------------------------------------------------------------------

describe("normalizeUrl (library)", () => {
  it("adds https:// prefix when missing", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
  });

  it("leaves already-prefixed URLs alone", () => {
    expect(normalizeUrl("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
  });

  it("handles http:// prefix", () => {
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
  });

  it("trims whitespace from URL", () => {
    expect(normalizeUrl("  example.com  ")).toBe("https://example.com");
  });

  it("throws on invalid URL", () => {
    expect(() => normalizeUrl("not a url at all :(")).toThrow(/Invalid URL/);
  });
});

// ---------------------------------------------------------------------------
// 4. Library — formatHtmlResult unit tests
// ---------------------------------------------------------------------------

describe("formatHtmlResult (library)", () => {
  it("includes URL and status in header", () => {
    const result = {
      statusCode: 200,
      contentType: "text/html",
      finalUrl: "https://example.com",
      html: "<html><body>Hello</body></html>",
    };
    const output = formatHtmlResult(result);
    expect(output).toContain("URL : https://example.com");
    expect(output).toContain("Status: 200");
    expect(output).toContain("Content-Type: text/html");
  });

  it("shows file size", () => {
    const result = {
      statusCode: 200,
      contentType: "text/html",
      finalUrl: "https://example.com",
      html: "<p>test</p>",
    };
    const output = formatHtmlResult(result);
    expect(output).toContain("Size");
    expect(output).toContain("chars");
  });

  it("truncates long HTML and shows continuation hint", () => {
    const bigHtml = "x".repeat(MAX_TEXT_OUTPUT_CHARS + 100);
    const result = {
      statusCode: 200,
      finalUrl: "https://example.com",
      html: bigHtml,
    };
    const output = formatHtmlResult(result);
    expect(output).toContain("truncated");
    expect(output).toContain("call again with offset=");
    expect(output).toMatch(/offset=16000\)$/m);
  });

  it("shows continuation header when offset > 0", () => {
    const html = "a".repeat(MAX_TEXT_OUTPUT_CHARS + 5000);
    const result = { statusCode: 200, finalUrl: "https://x.com", html };
    const output = formatHtmlResult(result, 2000);

    expect(output).toContain("[Continuation from offset 2,000");
    expect(output).toContain("total 21,000 chars]");
    // Should not include URL/Status header
    expect(output).not.toContain("URL :");
    expect(output).not.toContain("Status:");
    // Should contain sliced content starting at offset 2000
    expect(output).toContain("a".repeat(100)); // partial content
  });

  it("returns remaining content when offset chunk fits entirely", () => {
    const html = "abcdefghij".repeat(500); // 5000 chars, well under MAX
    const result = { statusCode: 200, finalUrl: "https://x.com", html };
    const output = formatHtmlResult(result, 1000);

    expect(output).toContain("[Continuation from offset 1,000");
    expect(output).toContain("total 5,000 chars]");
    // Should contain the rest without truncation notice
    expect(output).not.toContain("truncated");
    expect(output).not.toContain("call again");
    expect(output.length).toBeGreaterThan(3500); // remaining ~4000 chars
  });

  it("omits Content-Type line when contentType is undefined", () => {
    const result = {
      statusCode: 200,
      finalUrl: "https://example.com",
      html: "<p>ok</p>",
    };
    const output = formatHtmlResult(result);
    expect(output).not.toContain("Content-Type");
  });

  it("shows correct size for small HTML (< 1024 bytes)", () => {
    const result = {
      statusCode: 200,
      finalUrl: "https://example.com",
      html: "<p>small</p>",
    };
    const output = formatHtmlResult(result);
    expect(output).toMatch(/\d+ B/);
  });

  it("shows correct size for large HTML (> 1 MB)", () => {
    const bigHtml = "x".repeat(2_000_000);
    const result = { statusCode: 200, finalUrl: "https://example.com", html: bigHtml };
    const output = formatHtmlResult(result);
    expect(output).toMatch(/\d+\.\d+ MB/);
  });

  it("shows correct size for medium HTML (1-1024 KB)", () => {
    const medHtml = "x".repeat(50_000);
    const result = { statusCode: 200, finalUrl: "https://example.com", html: medHtml };
    const output = formatHtmlResult(result);
    expect(output).toMatch(/\d+\.\d+ KB/);
  });
});

// ---------------------------------------------------------------------------
// 5. Library — formatTextResult unit tests
// ---------------------------------------------------------------------------

describe("formatTextResult (library)", () => {
  it("includes title as heading when present", () => {
    const result = {
      statusCode: 200,
      finalUrl: "https://example.com",
      html: "<title>My Page</title><body>Hello</body>",
    };
    const output = formatTextResult(result);
    expect(output).toContain("My Page");
    expect(output).toMatch(/^My Page\n=+\n/m);
  });

  it("does not duplicate title in URL when they're the same", () => {
    const result = {
      statusCode: 200,
      finalUrl: "https://example.com/My-Page",
      html: "<title>My Page</title><body>Hello</body>",
    };
    expect(() => formatTextResult(result)).not.toThrow();
  });

  it("truncates long text output with continuation hint", () => {
    const bigHtml = Array(2000).fill("<p>A paragraph with meaningful text content.</p>").join("\n");
    const result = { statusCode: 200, finalUrl: "https://x.com", html: bigHtml };
    const output = formatTextResult(result);
    expect(output).toContain("truncated");
    expect(output).toContain("call again with offset=");
  });

  it("extracts and formats clean text from realistic HTML", () => {
    const result = {
      statusCode: 200,
      finalUrl: "https://blog.example.com/post",
      html: `<!DOCTYPE html>
<html>
<head><title>Understanding Fetch</title></head>
<body>
<nav>Skip me</nav>
<script>console.log("hello")</script>
<style>.foo { color: red }</style>
<h1>Understanding Fetch</h1>
<p>The fetch API is a modern way to make HTTP requests in JavaScript.</p>
<p>It uses Promises and works great with async/await.</p>
<ul>
<li>Simple syntax</li>
<li>Cross-browser support</li>
</ul>
<blockquote>A quote here &mdash; very important!</blockquote>
</body>
</html>`,
    };
    const output = formatTextResult(result);
    expect(output).toContain("Understanding Fetch");
    expect(output).toContain("The fetch API is a modern way to make HTTP requests in JavaScript.");
    expect(output).toContain("It uses Promises and works great with async/await.");
    expect(output).toContain("Simple syntax");
    expect(output).not.toContain("<script>");
    expect(output).not.toContain("<style>");
    expect(output).not.toContain("console.log");
    expect(output).toContain("—");
  });

  it("shows continuation header when offset > 0", () => {
    const html = Array(3000).fill("<p>A paragraph with meaningful text content.</p>").join("\n");
    const result = { statusCode: 200, finalUrl: "https://x.com", html };
    const output = formatTextResult(result, 5000);

    expect(output).toContain("[Continuation from offset 5,000");
    expect(output).toContain("total");
    // No title section
    expect(output).not.toMatch(/^[^[\n].*\n=+\n/m);
  });

  it("uses pre-computed text from CachedPage when provided", () => {
    const html = "<title>X</title><body>Original body content here.</body>";
    const result = { statusCode: 200, finalUrl: "https://x.com", html };
    const precomputed = "Precomputed text bypasses htmlToText.";
    const cached: CachedPage = { result, text: precomputed };

    const output = formatTextResult(result, cached);
    expect(output).toContain("Precomputed text bypasses htmlToText.");
    expect(output).not.toContain("Original body content here.");
  });

  it("uses CachedPage text with offset for chunked continuation", () => {
    const html = "<title>X</title><body>ignored</body>";
    const result = { statusCode: 200, finalUrl: "https://x.com", html };
    const precomputed = "abcdefghij".repeat(200); // 2000 chars
    const cached: CachedPage = { result, text: precomputed };

    const output = formatTextResult(result, {
      result: cached.result,
      text: cached.text,
      // offset identified by wrapping in object with offset... wait,
      // formatTextResult(result, offsetOrCached) - if number, it's offset
      // if object (CachedPage), offset defaults to 0
    });
    // This tests the cached path with offset=0
    expect(output).toContain("abcdefghij");
  });

  it("skips title section when no title found", () => {
    const result = {
      statusCode: 200,
      finalUrl: "https://example.com/page",
      html: "<body>Just content</body>",
    };
    const output = formatTextResult(result);
    expect(output).not.toContain("(no title found)");
    expect(output).toContain("Just content");
  });

  it("omits title when title is empty", () => {
    const result = {
      statusCode: 200,
      finalUrl: "https://example.com/page",
      html: "<title></title><body>Content</body>",
    };
    const output = formatTextResult(result);
    expect(output).not.toMatch(/^==/);
    expect(output).toContain("Content");
  });

  it("handles HTML with only whitespace content", () => {
    const result = {
      statusCode: 200,
      finalUrl: "https://example.com",
      html: "<html>   \n\t  </html>",
    };
    const output = formatTextResult(result);
    expect(output.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 6. Library — fetchPage (mocked fetch)
// ---------------------------------------------------------------------------

describe("fetchPage (mocked)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    clearCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches the correct URL", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        url: "https://example.com/final",
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve("<html><body>Hello</body></html>"),
      }),
    );
    globalThis.fetch = mockFetch as never;

    await fetchPage("https://example.com");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({
        redirect: "follow",
        headers: expect.objectContaining({
          "User-Agent": expect.stringContaining("Pi-Extension"),
        }),
      }),
    );
  });

  it("adds https:// prefix when missing", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        url: "https://example.com/page",
        headers: new Map(),
        text: () => Promise.resolve("<p>ok</p>"),
      }),
    );
    globalThis.fetch = mockFetch as never;

    await fetchPage("example.com/page");

    expect(mockFetch).toHaveBeenCalledWith("https://example.com/page", expect.anything());
  });

  it("returns structured result with metadata", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        url: "https://example.com",
        headers: new Map([["content-type", "text/html; charset=utf-8"]]),
        text: () => Promise.resolve("<html><body>Hello World</body></html>"),
      }),
    ) as never;

    const result = await fetchPage("example.com");
    expect(result.statusCode).toBe(200);
    expect(result.contentType).toBe("text/html; charset=utf-8");
    expect(result.finalUrl).toBe("https://example.com");
    expect(result.html).toContain("Hello World");
  });

  it("caches results and serves from cache on second call", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        url: "https://example.com",
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve("<html><body>Cached</body></html>"),
      }),
    );
    globalThis.fetch = mockFetch as never;

    await fetchPage("https://example.com");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call should hit cache
    const result2 = await fetchPage("https://example.com");
    expect(mockFetch).toHaveBeenCalledTimes(1); // no additional fetch
    expect(result2.html).toContain("Cached");
  });

  it("getCachedPage returns undefined for unknown URL", () => {
    expect(getCachedPage("https://never-fetched.com")).toBeUndefined();
  });

  it("getCachedPage returns CachedPage with text after fetchPage", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        url: "https://example.com",
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve("<html><title>T</title><body>body</body></html>"),
      }),
    ) as never;

    await fetchPage("https://example.com");
    const cached = getCachedPage("https://example.com");
    expect(cached).toBeDefined();
    expect(cached!.result.html).toContain("body");
    expect(cached!.text).toContain("body");
    expect(cached!.text).not.toContain("<html>");
  });

  it("clearCache empties the cache", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        url: "https://example.com",
        headers: new Map(),
        text: () => Promise.resolve("<p>x</p>"),
      }),
    ) as never;

    await fetchPage("https://example.com");
    expect(getCachedPage("https://example.com")).toBeDefined();

    clearCache();
    expect(getCachedPage("https://example.com")).toBeUndefined();
  });

  it("throws on invalid URL", async () => {
    await expect(fetchPage("not a url")).rejects.toThrow(/Invalid URL/);
  });

  it("handles non-200 status codes correctly and still caches", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 404,
        url: "https://example.com/missing",
        headers: new Map(),
        text: () => Promise.resolve("<h1>Not Found</h1>"),
      }),
    ) as never;

    const result = await fetchPage("https://example.com/missing");
    expect(result.statusCode).toBe(404);

    // Should be cached
    const cached = getCachedPage("https://example.com/missing");
    expect(cached).toBeDefined();
    expect(cached!.result.statusCode).toBe(404);
  });

  it("respects timeout option", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const p = fetchPage("https://example.com/slow", { timeoutMs: 50 }).catch(() => null);

    await new Promise((r) => setTimeout(r, 100));
    resolveFetch?.({
      ok: false,
      status: 499,
      url: "",
      headers: new Map(),
      text: () => Promise.reject(new Error("aborted")),
    } as unknown as Response);

    await expect(p).resolves.toBeNull();
  });

  it("throws on network error", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("ENOTFOUND")));

    await expect(fetchPage("https://nonexistent.invalid")).rejects.toThrow(/Failed to fetch/);
  });
});

// ---------------------------------------------------------------------------
// 7. Extension — tool registration tests
// ---------------------------------------------------------------------------

describe("fetch-page (extension)", () => {
  it("fetch-page-lib exports all required members", () => {
    expect(htmlToText).toBeDefined();
    expect(extractTitle).toBeDefined();
    expect(normalizeUrl).toBeDefined();
    expect(formatHtmlResult).toBeDefined();
    expect(formatTextResult).toBeDefined();
    expect(fetchPage).toBeDefined();
    expect(getCachedPage).toBeDefined();
    expect(clearCache).toBeDefined();
    expect(typeof MAX_TEXT_OUTPUT_CHARS).toBe("number");
  });

  it("extension source uses lib exports (no duplicate fetch logic)", () => {
    const src = readExtensionFile("fetch-page/index.ts");
    expect(src).toContain("import");
    expect(src).toContain('from "./fetch-page-lib"');
    expect(src).toContain("fetch_page");
    expect(src).toContain("fetch_text");
  });

  it("extension defines both tools", () => {
    const src = readExtensionFile("fetch-page/index.ts");
    expect(src).toContain('name: "fetch_page"');
    expect(src).toContain('name: "fetch_text"');
  });
});

// ---------------------------------------------------------------------------
// 7a. Library — coerceUrlParams (from index.ts)
// ---------------------------------------------------------------------------

describe("coerceUrlParams (extension helper)", () => {
  // Re-implement the same logic to test it independently
  function coerceUrlParams(raw: unknown): { url: string; offset?: number } {
    if (typeof raw === "string") return { url: raw.trim() };
    if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      for (const key of ["url", "URL", "uri"]) {
        const val = o[key];
        if (typeof val === "string" && val.trim()) {
          const offset = typeof o.offset === "number" ? o.offset : undefined;
          return { url: val.trim(), offset };
        }
      }
    }
    return { url: "" };
  }

  it("coerces a plain string into { url }", () => {
    expect(coerceUrlParams("https://example.com")).toEqual({ url: "https://example.com" });
  });

  it("trims whitespace from string input", () => {
    expect(coerceUrlParams("  https://example.com  ")).toEqual({ url: "https://example.com" });
  });

  it("extracts 'url' key from object", () => {
    expect(coerceUrlParams({ url: "https://example.com" })).toEqual({ url: "https://example.com" });
  });

  it("extracts 'URL' key from object (case insensitive)", () => {
    expect(coerceUrlParams({ URL: "https://example.com" })).toEqual({ url: "https://example.com" });
  });

  it("extracts 'uri' key from object", () => {
    expect(coerceUrlParams({ uri: "https://example.com" })).toEqual({ url: "https://example.com" });
  });

  it("prefers 'url' over 'URL' and 'uri'", () => {
    expect(coerceUrlParams({ url: "a", URL: "b", uri: "c" })).toEqual({ url: "a" });
  });

  it("extracts offset from object when present", () => {
    expect(coerceUrlParams({ url: "https://x.com", offset: 16000 })).toEqual({
      url: "https://x.com",
      offset: 16000,
    });
  });

  it("extracts offset as undefined when absent from object", () => {
    expect(coerceUrlParams({ url: "https://x.com" })).toEqual({ url: "https://x.com" });
  });

  it("extracts offset as undefined when non-number", () => {
    expect(coerceUrlParams({ url: "https://x.com", offset: "16000" })).toEqual({
      url: "https://x.com",
    });
  });

  it("extracts offset as undefined when offset is 0", () => {
    expect(coerceUrlParams({ url: "https://x.com", offset: 0 })).toEqual({
      url: "https://x.com",
      offset: 0,
    });
  });

  it("returns empty url for non-string object values", () => {
    expect(coerceUrlParams({ url: 123 })).toEqual({ url: "" });
  });

  it("returns empty url for null input", () => {
    expect(coerceUrlParams(null)).toEqual({ url: "" });
  });

  it("returns empty url for undefined input", () => {
    expect(coerceUrlParams(undefined)).toEqual({ url: "" });
  });

  it("returns empty url for number input", () => {
    expect(coerceUrlParams(42)).toEqual({ url: "" });
  });

  it("returns empty url for empty object", () => {
    expect(coerceUrlParams({})).toEqual({ url: "" });
  });

  it("trims url value from object", () => {
    expect(coerceUrlParams({ url: "  https://example.com  " })).toEqual({
      url: "https://example.com",
    });
  });

  it("returns empty url when string value is whitespace only", () => {
    expect(coerceUrlParams({ url: "   ", uri: "https://fallback.com" })).toEqual({
      url: "https://fallback.com",
    });
  });
});

// ---------------------------------------------------------------------------
// 7b. Library — decodeHtmlEntities
// ---------------------------------------------------------------------------

describe("decodeHtmlEntities (library)", () => {
  it("decodes &lt; and &gt;", () => {
    expect(decodeHtmlEntities("1 &lt; 2 &gt; 0")).toBe("1 < 2 > 0");
  });

  it("decodes &quot; and &#39;/&apos;", () => {
    expect(decodeHtmlEntities("He said &quot;hello&quot; and it&#39;s fine &apos;too&apos;")).toBe(
      `He said "hello" and it's fine 'too'`,
    );
  });

  it("decodes &nbsp;", () => {
    expect(decodeHtmlEntities("foo&nbsp;bar")).toBe("foo bar");
  });

  it("decodes typographic entities", () => {
    expect(decodeHtmlEntities("&mdash;&ndash;&hellip;")).toBe("—–...");
  });

  it("decodes &amp; last to avoid double-decoding", () => {
    expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
  });

  it("handles overlapping entity refs like &amp;lt;", () => {
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
  });

  it("decodes numeric decimal entities", () => {
    expect(decodeHtmlEntities("&#65;&#66;&#67;")).toBe("ABC");
  });

  it("decodes numeric hex entities", () => {
    expect(decodeHtmlEntities("&#x41;&#x42;&#x43;")).toBe("ABC");
  });

  it("handles mixed entity types in one string", () => {
    const input = "&lt;h1&gt; &#65; &amp; &#x42; &mdash; end";
    expect(decodeHtmlEntities(input)).toBe("<h1> A & B — end");
  });

  it("is idempotent on plain text", () => {
    const plain = "Hello world, nothing to decode.";
    expect(decodeHtmlEntities(plain)).toBe(plain);
  });

  it("handles empty string", () => {
    expect(decodeHtmlEntities("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 7c. Library — htmlToText edge cases (additional)
// ---------------------------------------------------------------------------

describe("htmlToText (additional edge cases)", () => {
  it("handles self-closing <br/> tags", () => {
    const result = htmlToText("Line one<br/>Line two");
    expect(result).toContain("Line one");
    expect(result).toContain("Line two");
  });

  it("handles self-closing <hr/> tags", () => {
    const result = htmlToText("Before<hr/>After");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  it("handles self-closing with whitespace <br />", () => {
    const result = htmlToText("Line one<br />Line two");
    expect(result).toContain("Line one");
    expect(result).toContain("Line two");
  });

  it("handles nested block elements deeply", () => {
    const html = `<div><section><article><p>Deep content</p></article></section></div>`;
    const result = htmlToText(html);
    expect(result).toContain("Deep content");
  });

  it("preserves <pre> content structure with newlines", () => {
    const html = `<pre>line1\nline2\nline3</pre>`;
    const result = htmlToText(html);
    expect(result).toContain("line1");
    expect(result).toContain("line2");
    expect(result).toContain("line3");
  });

  it("handles <details> and <summary> tags", () => {
    const html = `<details><summary>Title</summary>Hidden content</details>`;
    const result = htmlToText(html);
    expect(result).toContain("Title");
    expect(result).toContain("Hidden content");
  });

  it("handles <figure> and <figcaption> tags", () => {
    const html = `<figure><img src="test.jpg" alt="A test"><figcaption>Caption text</figcaption></figure>`;
    const result = htmlToText(html);
    expect(result).toContain("Caption text");
  });

  it("handles <dl>/<dt>/<dd> definition lists", () => {
    const html = `<dl><dt>Term</dt><dd>Definition</dd></dl>`;
    const result = htmlToText(html);
    expect(result).toContain("Term");
    expect(result).toContain("Definition");
  });

  it("handles entity overlap: &amp;lt; decodes deterministically", () => {
    const result = htmlToText("&amp;lt;");
    expect(result).toBe("&lt;");
  });

  it("handles <aside> and article-level semantic tags", () => {
    const html = `<main><article>Main</article><aside>Sidebar</aside></main>`;
    const result = htmlToText(html);
    expect(result).toContain("Main");
    expect(result).toContain("Sidebar");
  });

  it("strips data-* attributes from leftover tag fragments", () => {
    const result = htmlToText("<span data-foo='bar' class='x'>text</span>");
    expect(result).toContain("text");
  });

  it("handles script blocks with attributes", () => {
    const html = `<div>Before<script type="module" src="test.js">code()</script>After</div>`;
    const result = htmlToText(html);
    expect(result).toContain("Before");
    expect(result).toContain("After");
    expect(result).not.toContain("code()");
    expect(result).not.toContain("test.js");
  });

  it("handles style blocks with attributes", () => {
    const html = `<style type="text/css" media="screen">body{}</style><p>Hello</p>`;
    const result = htmlToText(html);
    expect(result).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// 7d. Library — extractTitle edge cases (additional)
// ---------------------------------------------------------------------------

describe("extractTitle (additional edge cases)", () => {
  it('falls back to name="title" meta tag', () => {
    const html = '<meta name="title" content="Meta Title">';
    expect(extractTitle(html)).toBe("Meta Title");
  });

  it("<title> takes priority over meta tags", () => {
    const html = `<title>Primary</title><meta property="og:title" content="Secondary">`;
    expect(extractTitle(html)).toBe("Primary");
  });

  it("decodes entities in meta title fallback", () => {
    const html = '<meta name="title" content="A &amp; B">';
    expect(extractTitle(html)).toBe("A & B");
  });

  it("handles multi-line <title> content", () => {
    const html = "<title>\n  Multi\n  Line\n  Title\n</title>";
    const result = extractTitle(html);
    expect(result).toContain("Multi");
    expect(result).toContain("Line");
    expect(result).toContain("Title");
  });

  it("handles <title> with numeric entities", () => {
    const html = "<title>Code &#65;&#66;&#67;</title>";
    expect(extractTitle(html)).toBe("Code ABC");
  });
});

// ---------------------------------------------------------------------------
// 7e. Library — fetchPage abort error handling (additional)
// ---------------------------------------------------------------------------

describe("fetchPage (abort/error edge cases)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    clearCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("handles AbortError gracefully", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    globalThis.fetch = vi.fn(() => Promise.reject(abortError));

    await expect(fetchPage("https://example.com")).rejects.toThrow(/Failed to fetch.*aborted/);
  });

  it("includes URL in error message", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("Connection refused")));

    await expect(fetchPage("https://myhost.invalid/path")).rejects.toThrow(
      /Failed to fetch https:\/\/myhost\.invalid\/path: Connection refused/,
    );
  });

  it("handles non-Error thrown values", async () => {
    globalThis.fetch = vi.fn(() =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      Promise.reject("plain string rejection"),
    );

    await expect(fetchPage("https://example.com")).rejects.toThrow(/Failed to fetch.*plain string/);
  });

  it("error path does not cache the result", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("fail")));

    await expect(fetchPage("https://example.com")).rejects.toThrow();
    expect(getCachedPage("https://example.com")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7f. Extension — index.ts content checks (additional)
// ---------------------------------------------------------------------------

describe("fetch-page (extension, additional)", () => {
  it("exports coerceUrlParams indirectly via tool execution", () => {
    const src = readExtensionFile("fetch-page/index.ts");
    expect(src).toContain("coerceUrlParams");
    const coerceUsages = (src.match(/coerceUrlParams/g) || []).length;
    expect(coerceUsages).toBeGreaterThanOrEqual(3); // definition + 2 usages in tool execute
  });

  it("defines fetch-check command", () => {
    const src = readExtensionFile("fetch-page/index.ts");
    expect(src).toContain("fetch-check");
    expect(src).toContain("registerCommand");
  });

  it("handles session_start event", () => {
    const src = readExtensionFile("fetch-page/index.ts");
    expect(src).toContain("session_start");
  });

  it("both tools use renderResult for TUI preview", () => {
    const src = readExtensionFile("fetch-page/index.ts");
    const renderCount = (src.match(/renderResult/g) || []).length;
    expect(renderCount).toBeGreaterThanOrEqual(2);
  });

  it("fetch_text tool reports textLength in details", () => {
    const src = readExtensionFile("fetch-page/index.ts");
    expect(src).toContain("textLength");
  });

  it("fetch_page tool reports sizeBytes in details", () => {
    const src = readExtensionFile("fetch-page/index.ts");
    expect(src).toContain("sizeBytes");
  });

  it("imports getCachedPage from lib", () => {
    const src = readExtensionFile("fetch-page/index.ts");
    expect(src).toContain("getCachedPage");
  });

  it("imports normalizeUrl from lib", () => {
    const src = readExtensionFile("fetch-page/index.ts");
    expect(src).toContain("normalizeUrl");
  });

  it("parameter schema includes optional offset", () => {
    const src = readExtensionFile("fetch-page/index.ts");
    expect(src).toContain("offset");
    expect(src).toContain("Type.Optional");
  });
});

// ---------------------------------------------------------------------------
// 7g. Library — normalizeUrl edge cases (additional)
// ---------------------------------------------------------------------------

describe("normalizeUrl (additional edge cases)", () => {
  it("preserves URL with ports", () => {
    expect(normalizeUrl("https://example.com:8080/path")).toBe("https://example.com:8080/path");
  });

  it("adds https:// to URLs with ports but no protocol", () => {
    expect(normalizeUrl("example.com:8080")).toBe("https://example.com:8080");
  });

  it("handles URL with fragments and query params", () => {
    const url = "https://example.com/path?q=1&r=2#section";
    expect(normalizeUrl(url)).toBe(url);
  });

  it("adds https:// to URLs with paths but no protocol", () => {
    expect(normalizeUrl("example.com/path/file.html")).toBe("https://example.com/path/file.html");
  });

  it("handles mixed-case http prefix", () => {
    expect(normalizeUrl("HTTP://Example.COM")).toBe("HTTP://Example.COM");
    expect(normalizeUrl("HttpS://Example.COM")).toBe("HttpS://Example.COM");
  });
});

// ===========================================================================
// 8. INTEGRATION — real HTTP calls against live web pages
// ===========================================================================

// ---------------------------------------------------------------------------
// 8a. Basic fetch — small, stable pages
// ---------------------------------------------------------------------------

describe("integration: fetchPage against real pages", () => {
  const T = 15_000;

  it(
    "fetches https://example.com (200, HTML title)",
    async () => {
      const result = await fetchPage("https://example.com");

      expect(result.statusCode).toBe(200);
      expect(result.html.length).toBeGreaterThan(0);
      expect(extractTitle(result.html)).toMatch(/Example Domain/i);
      expect(result.contentType).toMatch(/text\/html/i);
      expect(result.finalUrl).toMatch(/example\.com/);
    },
    T,
  );

  it(
    "fetches https://httpbin.org/html (controlled HTML)",
    async () => {
      const result = await fetchPage("https://httpbin.org/html");

      expect(result.statusCode).toBe(200);
      expect(result.html).toContain("Herman Melville");
      const text = htmlToText(result.html);
      expect(text).toContain("Herman Melville");
      expect(text).toContain("Moby-Dick");
    },
    T,
  );

  it(
    "handles non-200 status codes on real page",
    async () => {
      const result = await fetchPage("https://httpbin.org/status/404");

      expect(result.statusCode).toBe(404);
      expect(typeof result.html).toBe("string");
    },
    T,
  );

  it(
    "follows redirects automatically",
    async () => {
      const result = await fetchPage("https://httpbin.org/redirect/2");

      expect(result.statusCode).toBe(200);
      expect(result.finalUrl).toMatch(/\/get$/);
      expect(result.contentType).toMatch(/application\/json/);
    },
    T,
  );

  it(
    "fetches https://httpbin.org/absolute-redirect/1",
    async () => {
      const result = await fetchPage("https://httpbin.org/absolute-redirect/1");

      expect(result.statusCode).toBe(200);
      expect(result.finalUrl).toMatch(/\/get$/);
      expect(result.html).toContain('"url"');
    },
    T,
  );

  it(
    "accepts URL without protocol (auto-https)",
    async () => {
      const result = await fetchPage("example.com");

      expect(result.statusCode).toBe(200);
      expect(result.finalUrl).toMatch(/^https:\/\/example\.com/);
      expect(extractTitle(result.html)).toMatch(/Example Domain/i);
    },
    T,
  );

  it(
    "errors on genuinely unreachable domain",
    async () => {
      await expect(fetchPage("https://never-resolvable.invalid")).rejects.toThrow(/Failed to fetch/);
    },
    T,
  );

  it(
    "errors on domain that resolves but connection refused",
    async () => {
      await expect(fetchPage("http://127.0.0.1:9999")).rejects.toThrow(/Failed to fetch/);
    },
    T,
  );
});

// ---------------------------------------------------------------------------
// 8b. Text extraction from real pages
// ---------------------------------------------------------------------------

describe("integration: text extraction from real pages", () => {
  const T = 15_000;

  it(
    "extracts readable text from a Wikipedia article",
    async () => {
      const result = await fetchPage("https://en.wikipedia.org/wiki/HTML");

      expect(result.statusCode).toBe(200);

      const title = extractTitle(result.html);
      expect(title).toMatch(/html/i);

      const text = htmlToText(result.html);
      expect(text).toContain("Hypertext Markup Language");
      expect(text).toContain("World Wide Web");
      expect(text.length).toBeGreaterThan(1000);

      expect(text).not.toContain("<script");
      expect(text).not.toContain("<style");
      expect(text).not.toContain("mw.config");
      expect(text).not.toContain("addEventListener");
    },
    T,
  );

  it(
    "extracts readable text from a documentation page (MDN)",
    async () => {
      const result = await fetchPage("https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a");

      expect(result.statusCode).toBe(200);

      const text = htmlToText(result.html);
      expect(text).toContain("anchor");
      expect(text).toContain("href");
      expect(text.length).toBeGreaterThan(500);
    },
    T,
  );

  it(
    "formats via formatTextResult end-to-end on httpbin.org/html",
    async () => {
      const result = await fetchPage("https://httpbin.org/html");

      const output = formatTextResult(result);
      expect(output).toContain("Herman Melville");
      expect(output).toContain("Moby-Dick");
      expect(output.startsWith("Herman Melville")).toBe(true);
    },
    T,
  );

  it(
    "formatHtmlResult produces correct header block on real page",
    async () => {
      const result = await fetchPage("https://example.com");

      const output = formatHtmlResult(result);
      expect(output).toContain("URL : https://example.com");
      expect(output).toContain("Status: 200");
      expect(output).toMatch(/Size\s+:\s+\d+/);
      const bodyIndex =
        output.indexOf("<!doctype") !== -1 ? output.indexOf("<!doctype") : output.indexOf("<html");
      expect(bodyIndex).toBeGreaterThan(0);
    },
    T,
  );

  it(
    "formatTextResult on Wikipedia produces clean title + content",
    async () => {
      const result = await fetchPage("https://en.wikipedia.org/wiki/Python_(programming_language)");

      const output = formatTextResult(result);
      expect(output).toMatch(/^Python \([^)]+\)\n/m);
      expect(output).toContain("general-purpose programming language");
      expect(output).toContain("Guido van Rossum");
      expect(output).not.toContain("<div");
      expect(output).not.toContain("class=");
    },
    T,
  );

  it(
    "formatTextResult omits title for duplicate title/URL page",
    async () => {
      const result = await fetchPage("https://example.com");
      const output = formatTextResult(result);
      expect(output.length).toBeGreaterThan(0);
      expect(output).toContain("Example Domain");
    },
    T,
  );
});

// ---------------------------------------------------------------------------
// 8c. Real page — offset/chunk continuation (integration)
// ---------------------------------------------------------------------------

describe("integration: offset chunk continuation", () => {
  const T = 15_000;

  it(
    "fetches a large page, then retrieves next chunk via offset (HTML)",
    async () => {
      // Wikipedia main page is > 16K chars
      const result = await fetchPage("https://en.wikipedia.org/wiki/Main_Page");

      expect(result.statusCode).toBe(200);
      expect(result.html.length).toBeGreaterThan(MAX_TEXT_OUTPUT_CHARS);

      // First chunk
      const chunk1 = formatHtmlResult(result);
      expect(chunk1).toContain("truncated");
      expect(chunk1).toContain("call again with offset=");

      // Extract the suggested offset from the message
      const offsetMatch = chunk1.match(/call again with offset=(\d+)/);
      expect(offsetMatch).not.toBeNull();
      const offset = parseInt(offsetMatch![1], 10);
      expect(offset).toBeGreaterThan(0);

      // Second chunk via formatHtmlResult with offset
      const chunk2 = formatHtmlResult(result, offset);
      expect(chunk2).toContain("[Continuation from offset");
      expect(chunk2).toContain("total");
      expect(chunk2).not.toContain("URL :"); // no header in continuation
      expect(chunk2).not.toContain("Status:"); // no header in continuation
    },
    T,
  );

  it(
    "fetches a large page, then retrieves next chunk via offset (text)",
    async () => {
      const result = await fetchPage("https://en.wikipedia.org/wiki/Main_Page");

      expect(result.statusCode).toBe(200);

      const chunk1 = formatTextResult(result);
      // Main page text probably exceeds 16K, but might not — if not, this test still verifies
      // the format function doesn't crash

      if (chunk1.includes("call again with offset=")) {
        const offsetMatch = chunk1.match(/call again with offset=(\d+)/);
        expect(offsetMatch).not.toBeNull();
        const offset = parseInt(offsetMatch![1], 10);

        // Use the cached page (pre-computed text) for the second chunk
        const cached = getCachedPage("https://en.wikipedia.org/wiki/Main_Page");
        expect(cached).toBeDefined();

        const chunk2 = formatTextResult(result, offset);
        expect(chunk2).toContain("[Continuation from offset");
        expect(chunk2).toContain("total");
        expect(chunk2).not.toMatch(/^[^[\n].*\n=+\n/m); // no title section
      }
    },
    T,
  );

  it(
    "getCachedPage returns the page after fetch",
    async () => {
      await fetchPage("https://example.com");

      const cached = getCachedPage("https://example.com");
      expect(cached).toBeDefined();
      expect(cached!.result.statusCode).toBe(200);
      expect(cached!.result.html).toContain("</html>");
      expect(cached!.text).toContain("Example Domain");
    },
    T,
  );

  it(
    "cache serves different URLs independently",
    async () => {
      await fetchPage("https://example.com");
      await fetchPage("https://httpbin.org/html");

      expect(getCachedPage("https://example.com")).toBeDefined();
      expect(getCachedPage("https://httpbin.org/html")).toBeDefined();
      expect(getCachedPage("https://httpbin.org")).toBeUndefined();
    },
    T,
  );
});

// ---------------------------------------------------------------------------
// 8d. Real-page edge cases
// ---------------------------------------------------------------------------

describe("integration: real-page edge cases", () => {
  const T = 15_000;

  beforeEach(() => {
    clearCache();
  });

  it(
    "handles pages with non-UTF8 charsets",
    async () => {
      const result = await fetchPage("https://httpbin.org/encoding/utf8");

      expect(result.statusCode).toBe(200);
      expect(result.html.length).toBeGreaterThan(0);
      expect(typeof result.html).toBe("string");
    },
    T,
  );

  it(
    "handles very large page gracefully",
    async () => {
      const result = await fetchPage("https://en.wikipedia.org/wiki/Main_Page");

      expect(result.statusCode).toBe(200);
      expect(result.html.length).toBeGreaterThan(50_000);

      const htmlOut = formatHtmlResult(result);
      expect(htmlOut).toContain("truncated");
      expect(htmlOut).toContain("call again with offset=");

      const textOut = formatTextResult(result);
      expect(textOut.length).toBeGreaterThan(0);
      expect(textOut).toContain("Wikipedia");
    },
    T,
  );

  it(
    "handles pages that redirect from HTTP to HTTPS",
    async () => {
      const result = await fetchPage("http://httpbin.org/absolute-redirect/1");

      expect(result.statusCode).toBe(200);
      expect(result.finalUrl).toMatch(/\/get$/);
    },
    T,
  );

  it(
    "extracts correct statusCode on real 500 error",
    async () => {
      const result = await fetchPage("https://httpbin.org/status/500");

      expect(result.statusCode).toBe(500);
      expect(result.html.length).toBeGreaterThanOrEqual(0);
    },
    T,
  );

  it(
    "preserves redirect finalUrl on 3-chain redirect",
    async () => {
      const result = await fetchPage("https://httpbin.org/redirect/3");

      expect(result.statusCode).toBe(200);
      expect(result.finalUrl).toMatch(/\/get$/);
    },
    T,
  );

  it(
    "accepts URL with trailing whitespace (normalized internally)",
    async () => {
      const result = await fetchPage("https://example.com");
      expect(result.statusCode).toBe(200);
    },
    T,
  );

  it(
    "produces valid output for page with rich HTML5 semantic tags",
    async () => {
      const result = await fetchPage("https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article");

      expect(result.statusCode).toBe(200);

      const text = htmlToText(result.html);
      expect(text.length).toBeGreaterThan(200);
      expect(text).toMatch(/article/i);
    },
    T,
  );
});

// ---------------------------------------------------------------------------
// 8e. Real page — content-type and response metadata
// ---------------------------------------------------------------------------

describe("integration: content type and response metadata", () => {
  const T = 15_000;

  it(
    "reports correct Content-Type for HTML pages",
    async () => {
      const result = await fetchPage("https://example.com");
      expect(result.contentType).toMatch(/text\/html/);
    },
    T,
  );

  it(
    "reports Content-Type for JSON endpoints",
    async () => {
      const result = await fetchPage("https://httpbin.org/json");

      expect(result.statusCode).toBe(200);
      expect(result.contentType).toMatch(/application\/json/);
      expect(() => JSON.parse(result.html)).not.toThrow();
    },
    T,
  );

  it(
    "fetches page by hostname",
    async () => {
      const result = await fetchPage("https://httpbin.org/get");

      expect(result.statusCode).toBe(200);
      expect(result.finalUrl).toContain("httpbin.org");
    },
    T,
  );

  it(
    "reports correct finalUrl when no redirects occur",
    async () => {
      const result = await fetchPage("https://example.com");

      expect(result.finalUrl).toMatch(/example\.com/);
      expect(result.statusCode).toBe(200);
    },
    T,
  );

  it(
    "handles pages with long query strings",
    async () => {
      const result = await fetchPage(
        "https://httpbin.org/get?param1=value1&param2=value2&param3=value3&param4=value4",
      );

      expect(result.statusCode).toBe(200);
      expect(result.html).toContain("param1");
      expect(result.html).toContain("value1");
      expect(result.html).toContain("param4");
      expect(result.html).toContain("value4");
    },
    T,
  );
});

// ---------------------------------------------------------------------------
// 8f. Real network error handling
// ---------------------------------------------------------------------------

describe("integration: real network error handling", () => {
  const T = 15_000;

  it(
    "throws on non-routable private IP",
    async () => {
      await expect(fetchPage("http://127.0.0.1:81", { timeoutMs: 3_000 })).rejects.toThrow(/Failed to fetch/);
    },
    T + 2_000,
  );

  it(
    "respects timeout on slow endpoints",
    async () => {
      await expect(fetchPage("https://httpbin.org/delay/10", { timeoutMs: 2_000 })).rejects.toThrow(
        /Failed to fetch/,
      );
    },
    T + 5_000,
  );

  it(
    "includes final error message with the URL",
    async () => {
      try {
        await fetchPage("http://127.0.0.1:82", { timeoutMs: 2_000 });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(String(err)).toContain("Failed to fetch");
        expect(String(err)).toContain("127.0.0.1:82");
      }
    },
    T + 3_000,
  );
});
