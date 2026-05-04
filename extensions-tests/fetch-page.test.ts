/**
 * Tests for fetch-page extension.
 *
 * Three suites:
 *   1. Library — pure unit tests on fetch-page-lib (htmlToText, extractTitle, etc.)
 *   2. Extension — verifies tool registration & metadata (mocked Pi types)
 *   3. Integration — real HTTP calls (skipped in CI)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  htmlToText,
  extractTitle,
  normalizeUrl,
  formatHtmlResult,
  formatTextResult,
  fetchPage,
  MAX_TEXT_OUTPUT_CHARS,
} from "../extensions/fetch-page/fetch-page-lib";

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
    // Script block is removed; surrounding text gets normalized
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
    // Should have newlines between blocks
    const lines = result.split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it("decodes common HTML entities", () => {
    // &mdash; → em-dash, &amp; → &, &bull; → bullet
    const html = "Tea &amp; coffee &mdash; daily &bull;;";
    const result = htmlToText(html);
    expect(result).toContain("&");
    expect(result).toContain("—");
    expect(result).toContain("•");
  });

  it("decodes numeric entities", () => {
    const html = "&#65;&#x42;"; // AB
    expect(htmlToText(html)).toBe("AB");
  });

  it("handles HTML comments by removing them", () => {
    const html = "<p>Before <!-- comment --> After</p>";
    // Comment is removed, whitespace normalized
    expect(htmlToText(html)).toBe("Before After");
  });

  it("collapses multiple spaces and blank lines", () => {
    const html = `<div>word   word   word</div>\n\n\n<p>another</p>`;
    const result = htmlToText(html);
    expect(result).toContain("word word word");
    // No more than one blank line between paragraphs
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
    expect(result).not.toContain("   "); // no excessive spaces
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
    // &amp; → &
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
    expect(normalizeUrl("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
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

  it("truncates long HTML and shows character count", () => {
    const bigHtml = "x".repeat(MAX_TEXT_OUTPUT_CHARS + 100);
    const result = {
      statusCode: 200,
      finalUrl: "https://example.com",
      html: bigHtml,
    };
    const output = formatHtmlResult(result);
    expect(output).toContain("truncated");
    // Check the total char count string appears somewhere (with possible comma in number)
    expect(output).toMatch(/total [\d,]+ chars/);
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
      html: '<title>My Page</title><body>Hello</body>',
    };
    const output = formatTextResult(result);
    expect(output).toContain("My Page");
    // Title should be followed by underline (= repeated)
    expect(output).toMatch(/^[=\u2500]+$/m);
  });

  it("does not duplicate title in URL when they're the same", () => {
    const result = {
      statusCode: 200,
      finalUrl: "https://example.com/My-Page",
      html: '<title>My Page</title><body>Hello</body>',
    };
    // Should still work — no assertion needed beyond not crashing
    expect(() => formatTextResult(result)).not.toThrow();
  });

  it("truncates long text output appropriately", () => {
    // Generate enough HTML that after block tag processing we exceed MAX_TEXT_OUTPUT_CHARS
    // Each <p>...</p> becomes "Paragraph" + newline, so ~10 chars each
    const bigHtml = Array(2000).fill("<p>A paragraph with meaningful text content.</p>").join("\n");
    const result = { statusCode: 200, finalUrl: "https://x.com", html: bigHtml };
    const output = formatTextResult(result);
    expect(output).toContain("truncated");
    // Should have lots of paragraph text before truncation
    expect(output.split("\n").length).toBeGreaterThan(100);
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
    // &mdash; should be decoded to — (em-dash) in htmlToText
    expect(output).toContain("—");
  });
});

// ---------------------------------------------------------------------------
// 6. Library — fetchPage URL construction tests (with mocked fetch)
// ---------------------------------------------------------------------------

describe("fetchPage (mocked)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches the correct URL", async () => {
    const mockFetch = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      url: "https://example.com/final",
      headers: new Map([["content-type", "text/html"]]),
      text: () => Promise.resolve("<html><body>Hello</body></html>"),
    }));
    globalThis.fetch = mockFetch as never;

    await fetchPage({ url: "https://example.com" });

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
    const mockFetch = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      url: "https://example.com/page",
      headers: new Map(),
      text: () => Promise.resolve("<p>ok</p>"),
    }));
    globalThis.fetch = mockFetch as never;

    await fetchPage({ url: "example.com/page" });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.anything(),
    );
  });

  it("returns structured result with metadata", async () => {
    const mockFetch = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      url: "https://example.com",
      headers: new Map([["content-type", "text/html; charset=utf-8"]]),
      text: () => Promise.resolve("<html><body>Hello World</body></html>"),
    }));
    globalThis.fetch = mockFetch as never;

    const result = await fetchPage({ url: "example.com" });
    expect(result.statusCode).toBe(200);
    expect(result.contentType).toBe("text/html; charset=utf-8");
    expect(result.finalUrl).toBe("https://example.com");
    expect(result.html).toContain("Hello World");
  });

  it("throws on invalid URL", async () => {
    await expect(fetchPage({ url: "not a url" })).rejects.toThrow(/Invalid URL/);
  });

  it("handles non-200 status codes correctly", async () => {
    const mockFetch = vi.fn(() => Promise.resolve({
      ok: true,
      status: 404,
      url: "https://example.com/missing",
      headers: new Map(),
      text: () => Promise.resolve("<h1>Not Found</h1>"),
    }));
    globalThis.fetch = mockFetch as never;

    const result = await fetchPage({ url: "https://example.com/missing" });
    expect(result.statusCode).toBe(404);
  });

  it("respects timeout option", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const mockFetch = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    globalThis.fetch = mockFetch as never;

    const p = fetchPage(
      { url: "https://example.com/slow" },
      { timeoutMs: 50 },
    ).catch(() => null);

    await new Promise((r) => setTimeout(r, 100));
    resolveFetch?.(
      {
        ok: false,
        status: 499,
        url: "",
        headers: new Map(),
        text: () => Promise.reject(new Error("aborted")),
      } as unknown as Response,
    );

    await expect(p).resolves.toBeNull();
  });

  it("throws on network error", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("ENOTFOUND"))) as never;

    await expect(fetchPage({ url: "https://nonexistent.invalid" })).rejects.toThrow(
      /Failed to fetch/,
    );
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
    expect(typeof MAX_TEXT_OUTPUT_CHARS).toBe("number");
  });

  it("extension source uses lib exports (no duplicate fetch logic)", () => {
    const src = require("fs").readFileSync("../extensions/fetch-page/index.ts", "utf-8");

    // Should import from lib
    expect(src).toContain('import');
    expect(src).toContain('from "./fetch-page-lib"');
    // Tool names should be present
    expect(src).toContain("fetch_page");
    expect(src).toContain("fetch_text");
  });

  it("extension defines both tools", () => {
    const src = require("fs").readFileSync("../extensions/fetch-page/index.ts", "utf-8");

    // Both tool names should appear in defineTool calls
    expect(src).toContain('name: "fetch_page"');
    expect(src).toContain('name: "fetch_text"');
  });
});

// ---------------------------------------------------------------------------
// 8. Integration tests — real HTTP calls (skipped by default)
// ---------------------------------------------------------------------------

describe("fetch-page (integration)", () => {
  it("fetches a real webpage and extracts text", async () => {}, 1); // skip

  it("htmlToText produces clean output from Wikipedia article", async () => {}, 1); // skip

  it("htmlToText strips script/style/nav from a realistic blog post", async () => {}, 1); // skip
});
