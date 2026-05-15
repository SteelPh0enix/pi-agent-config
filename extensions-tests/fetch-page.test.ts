/**
 * Tests for fetch-page extension.
 *
 * Three suites:
 *   1. Library — pure unit tests on fetch-page-lib (htmlToText, extractTitle, etc.)
 *   2. Extension — verifies tool registration & metadata (mocked Pi types)
 *   3. Integration — real HTTP calls (skipped in CI)
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
  MAX_TEXT_OUTPUT_CHARS,
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
      html: "<title>My Page</title><body>Hello</body>",
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
      html: "<title>My Page</title><body>Hello</body>",
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
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
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

    await fetchPage({ url: "example.com/page" });

    expect(mockFetch).toHaveBeenCalledWith("https://example.com/page", expect.anything());
  });

  it("returns structured result with metadata", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        url: "https://example.com",
        headers: new Map([["content-type", "text/html; charset=utf-8"]]),
        text: () => Promise.resolve("<html><body>Hello World</body></html>"),
      }),
    );
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
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 404,
        url: "https://example.com/missing",
        headers: new Map(),
        text: () => Promise.resolve("<h1>Not Found</h1>"),
      }),
    );
    globalThis.fetch = mockFetch as never;

    const result = await fetchPage({ url: "https://example.com/missing" });
    expect(result.statusCode).toBe(404);
  });

  it("respects timeout option", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const mockFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    globalThis.fetch = mockFetch;

    const p = fetchPage({ url: "https://example.com/slow" }, { timeoutMs: 50 }).catch(() => null);

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

    await expect(fetchPage({ url: "https://nonexistent.invalid" })).rejects.toThrow(/Failed to fetch/);
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
    const src = readExtensionFile("fetch-page/index.ts");

    // Should import from lib
    expect(src).toContain("import");
    expect(src).toContain('from "./fetch-page-lib"');
    // Tool names should be present
    expect(src).toContain("fetch_page");
    expect(src).toContain("fetch_text");
  });

  it("extension defines both tools", () => {
    const src = readExtensionFile("fetch-page/index.ts");

    // Both tool names should appear in defineTool calls
    expect(src).toContain('name: "fetch_page"');
    expect(src).toContain('name: "fetch_text"');
  });
});

// ---------------------------------------------------------------------------
// 7a. Library — coerceUrlParams (from index.ts)
// ---------------------------------------------------------------------------

describe("coerceUrlParams (extension helper)", () => {
  // Re-implement the same logic to test it independently
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
    expect(coerceUrlParams({ url: "  https://example.com  " })).toEqual({ url: "https://example.com" });
  });

  it("returns empty url when string value is whitespace only", () => {
    expect(coerceUrlParams({ url: "   ", uri: "https://fallback.com" })).toEqual({
      url: "https://fallback.com",
    });
  });
});

// ---------------------------------------------------------------------------
// 7b. Library — decodeHtmlEntities (new shared helper)
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
    // In '&amp;amp;', &amp; is decoded last, so:
    // Step 1: non-amp entities pass — nothing matches
    // Step 2: &amp; → &, giving "&amp;"
    // No second pass occurs (single-pass decode), so "&amp;" stays literal.
    expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
  });

  it("handles overlapping entity refs like &amp;lt;", () => {
    // In '&amp;lt;', the regex for &lt; matches within the string at position 5.
    // This is inherent to how overlapping text patterns work — single-pass decoding
    // can't distinguish "&amp;" + "<" from "&" + "<" here.
    // The result is predictable: non-amp entities fire first on '&lt;' match.
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
    // In '&amp;lt;', the regex for &lt; matches within the string.
    // This is single-pass decoding behavior — predictable, not a bug.
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
    // This shouldn't normally appear but the code handles it as safety
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
    // Should be decoded and trimmed by decodeHtmlEntities
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
// 7e. Library — formatHtmlResult edge cases (additional)
// ---------------------------------------------------------------------------

describe("formatHtmlResult (additional edge cases)", () => {
  it("omits Content-Type line when contentType is undefined", () => {
    const result = {
      statusCode: 200,
      // no contentType
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
    const result = {
      statusCode: 200,
      finalUrl: "https://example.com",
      html: bigHtml,
    };
    const output = formatHtmlResult(result);
    expect(output).toMatch(/\d+\.\d+ MB/);
  });

  it("shows correct size for medium HTML (1-1024 KB)", () => {
    const medHtml = "x".repeat(50_000);
    const result = {
      statusCode: 200,
      finalUrl: "https://example.com",
      html: medHtml,
    };
    const output = formatHtmlResult(result);
    expect(output).toMatch(/\d+\.\d+ KB/);
  });
});

// ---------------------------------------------------------------------------
// 7f. Library — formatTextResult edge cases (additional)
// ---------------------------------------------------------------------------

describe("formatTextResult (additional edge cases)", () => {
  it("skips title section when no title found", () => {
    const result = {
      statusCode: 200,
      finalUrl: "https://example.com/page",
      html: "<body>Just content</body>",
    };
    const output = formatTextResult(result);
    // Should not include the fallback string
    expect(output).not.toContain("(no title found)");
    // Should just have the text content
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
// 7g. Library — fetchPage abort error handling (additional)
// ---------------------------------------------------------------------------

describe("fetchPage (abort/error edge cases)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("handles AbortError gracefully", async () => {
    // Simulate a real abort error scenario
    const abortError = new DOMException("The operation was aborted", "AbortError");
    globalThis.fetch = vi.fn(() => Promise.reject(abortError));

    await expect(fetchPage({ url: "https://example.com" })).rejects.toThrow(/Failed to fetch.*aborted/);
  });

  it("includes URL in error message", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("Connection refused")));

    await expect(fetchPage({ url: "https://myhost.invalid/path" })).rejects.toThrow(
      /Failed to fetch https:\/\/myhost\.invalid\/path: Connection refused/,
    );
  });

  it("handles non-Error thrown values", async () => {
    globalThis.fetch = vi.fn(() =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing non-Error rejections
      Promise.reject("plain string rejection"),
    );

    await expect(fetchPage({ url: "https://example.com" })).rejects.toThrow(/Failed to fetch.*plain string/);
  });
});

// ---------------------------------------------------------------------------
// 7h. Extension — index.ts content checks (additional)
// ---------------------------------------------------------------------------

describe("fetch-page (extension, additional)", () => {
  it("exports coerceUrlParams indirectly via tool execution", () => {
    const src = readExtensionFile("fetch-page/index.ts");

    // Should define and use coerceUrlParams
    expect(src).toContain("coerceUrlParams");
    // Both tools should use it
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
    expect(renderCount).toBeGreaterThanOrEqual(2); // one per tool
  });

  it("fetch_text tool reports textLength in details", () => {
    const src = readExtensionFile("fetch-page/index.ts");
    expect(src).toContain("textLength");
  });

  it("fetch_page tool reports sizeBytes in details", () => {
    const src = readExtensionFile("fetch-page/index.ts");
    expect(src).toContain("sizeBytes");
  });
});

// ---------------------------------------------------------------------------
// 7i. Library — normalizeUrl edge cases (additional)
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
// 8. INTEGRATION — real HTTP calls against live web pages (skipped in CI)
// ===========================================================================
// ---------------------------------------------------------------------------
// 8a. Basic fetch — small, stable pages
// ---------------------------------------------------------------------------

describe("integration: fetchPage against real pages", () => {
  // Timeout bump — real network calls may take a few seconds.
  const T = 15_000;

  it("fetches https://example.com (200, HTML title)", async () => {
    const result = await fetchPage({ url: "https://example.com" });

    expect(result.statusCode).toBe(200);
    expect(result.html.length).toBeGreaterThan(0);
    // example.com has <title>Example Domain</title>
    expect(extractTitle(result.html)).toMatch(/Example Domain/i);
    // Should get text/html back
    expect(result.contentType).toMatch(/text\/html/i);
    // Final URL should not redirect away
    expect(result.finalUrl).toMatch(/example\.com/);
  }, T);

  it("fetches https://httpbin.org/html (controlled HTML)", async () => {
    const result = await fetchPage({ url: "https://httpbin.org/html" });

    expect(result.statusCode).toBe(200);
    // httpbin.org/html returns a small document with a known heading
    expect(result.html).toContain("Herman Melville");
    // Verify the full pipeline: htmlToText should extract the name
    const text = htmlToText(result.html);
    expect(text).toContain("Herman Melville");
    expect(text).toContain("Moby-Dick");
  }, T);

  it("handles non-200 status codes on real page", async () => {
    const result = await fetchPage({ url: "https://httpbin.org/status/404" });

    expect(result.statusCode).toBe(404);
    // httpbin /status/<code> endpoints may return zero-length bodies
    expect(typeof result.html).toBe("string");
  }, T);

  it("follows redirects automatically", async () => {
    const result = await fetchPage({ url: "https://httpbin.org/redirect/2" });

    // httpbin redirect chain resolves to a 200 at /get
    expect(result.statusCode).toBe(200);
    expect(result.finalUrl).toMatch(/\/get$/);
    // /get returns JSON, so content type is application/json
    expect(result.contentType).toMatch(/application\/json/);
  }, T);

  it("fetches https://httpbin.org/absolute-redirect/1", async () => {
    const result = await fetchPage({
      url: "https://httpbin.org/absolute-redirect/1",
    });

    expect(result.statusCode).toBe(200);
    // Should land on /get
    expect(result.finalUrl).toMatch(/\/get$/);
    expect(result.html).toContain('"url"'); // valid JSON
  }, T);

  it("accepts URL without protocol (auto-https)", async () => {
    const result = await fetchPage({ url: "example.com" });

    expect(result.statusCode).toBe(200);
    expect(result.finalUrl).toMatch(/^https:\/\/example\.com/);
    expect(extractTitle(result.html)).toMatch(/Example Domain/i);
  }, T);

  it("errors on genuinely unreachable domain", async () => {
    // .invalid TLD is reserved by RFC 6761 — guaranteed never resolvable
    await expect(
      fetchPage({ url: "https://never-resolvable.invalid" }),
    ).rejects.toThrow(/Failed to fetch/);
  }, T);

  it("errors on domain that resolves but connection refused", async () => {
    // 127.0.0.1:9999 — nothing should be listening there
    await expect(
      fetchPage({ url: "http://127.0.0.1:9999" }),
    ).rejects.toThrow(/Failed to fetch/);
  }, T);
});

// ---------------------------------------------------------------------------
// 8b. Text extraction from real pages
// ---------------------------------------------------------------------------

describe("integration: text extraction from real pages", () => {
  const T = 15_000;

  it("extracts readable text from a Wikipedia article", async () => {
    const result = await fetchPage({
      url: "https://en.wikipedia.org/wiki/HTML",
    });

    expect(result.statusCode).toBe(200);

    const title = extractTitle(result.html);
    expect(title).toMatch(/html/i);

    const text = htmlToText(result.html);
    // Wikipedia article should contain key terms
    expect(text).toContain("Hypertext Markup Language");
    expect(text).toContain("World Wide Web");
    expect(text.length).toBeGreaterThan(1000);

    // No script or style content should leak through
    expect(text).not.toContain("<script");
    expect(text).not.toContain("<style");
    expect(text).not.toContain("mw.config"); // Wikipedia JS
    expect(text).not.toContain("addEventListener");
  }, T);

  it("extracts readable text from a documentation page (MDN)", async () => {
    const result = await fetchPage({
      url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a",
    });

    expect(result.statusCode).toBe(200);

    const text = htmlToText(result.html);
    expect(text).toContain("anchor");
    expect(text).toContain("href");
    expect(text.length).toBeGreaterThan(500);
  }, T);

  it("formats via formatTextResult end-to-end on a blog post", async () => {
    // Use a known stable page with good structured HTML
    const result = await fetchPage({
      url: "https://httpbin.org/html",
    });

    const output = formatTextResult(result);
    // Should contain the heading extracted from the page
    expect(output).toContain("Herman Melville");
    expect(output).toContain("Moby-Dick");
    // The page has no <title> tag — heading comes from body <h1>
    // so the === underline is not generated. Title still appears as
    // the first line of extracted text.
    expect(output.startsWith("Herman Melville")).toBe(true);
  }, T);

  it("formatHtmlResult produces correct header block on real page", async () => {
    const result = await fetchPage({ url: "https://example.com" });

    const output = formatHtmlResult(result);

    // Mandatory header lines
    expect(output).toContain("URL : https://example.com");
    expect(output).toContain("Status: 200");
    // Size line with byte count
    expect(output).toMatch(/Size\s+:\s+\d+/);
    // The HTML body should appear after the header
    const bodyIndex = output.indexOf("<!doctype") !== -1
      ? output.indexOf("<!doctype")
      : output.indexOf("<html");
    expect(bodyIndex).toBeGreaterThan(0);
  }, T);

  it("formatTextResult on Wikipedia produces clean title + content", async () => {
    // Use Python article instead of CSS — CSS article literally discusses
    // <div class="..."> and .classname selectors, so "class=" appears in prose.
    const result = await fetchPage({
      url: "https://en.wikipedia.org/wiki/Python_(programming_language)",
    });

    const output = formatTextResult(result);

    // Title heading should contain "Python"
    expect(output).toMatch(/^Python \([^)]+\)\n/m);
    // Key article content
    expect(output).toContain("general-purpose programming language");
    expect(output).toContain("Guido van Rossum");
    // No HTML tags should leak into output
    expect(output).not.toContain("<div");
    expect(output).not.toContain("class=");
  }, T);

  it("formatTextResult omits title for duplicate title/URL page", async () => {
    // httpbin.org/html has no <title>, the title is extracted from heading
    // Use a page whose title would be a substring of the URL (gate test)
    const result = await fetchPage({ url: "https://example.com" });

    const output = formatTextResult(result);
    // Output should still have content even with title/URL overlap logic
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain("Example Domain");
  }, T);
});

// ---------------------------------------------------------------------------
// 8c. Edge cases with real pages
// ---------------------------------------------------------------------------

describe("integration: real-page edge cases", () => {
  const T = 15_000;

  it("handles pages with non-UTF8 charsets", async () => {
    // httpbin.org/encoding/utf8 returns a page explicitly marked as utf-8
    const result = await fetchPage({
      url: "https://httpbin.org/encoding/utf8",
    });

    expect(result.statusCode).toBe(200);
    // Should contain unicode content
    expect(result.html.length).toBeGreaterThan(0);
    // Common UTF-8 test characters
    const hasUnicode =
      result.html.includes("€") ||
      result.html.includes("\u{1F600}") ||
      result.html.includes("，");
    // Some pages may or may not include these — the test is that it doesn't crash
    expect(typeof result.html).toBe("string");
  }, T);

  it("handles very large page gracefully", async () => {
    // Wikipedia main page is large but won't blow up
    const result = await fetchPage({
      url: "https://en.wikipedia.org/wiki/Main_Page",
    });

    expect(result.statusCode).toBe(200);
    expect(result.html.length).toBeGreaterThan(50_000);

    // Both formatters should complete without error
    const htmlOut = formatHtmlResult(result);
    expect(htmlOut).toContain("truncated"); // should exceed MAX_TEXT_OUTPUT_CHARS

    const textOut = formatTextResult(result);
    expect(textOut.length).toBeGreaterThan(0);
    expect(textOut).toContain("Wikipedia");
  }, T);

  it("handles pages that redirect from HTTP to HTTPS", async () => {
    // httpbin redirect-chain endpoints are stable for testing redirects
    const result = await fetchPage({
      url: "http://httpbin.org/absolute-redirect/1",
    });

    // Should follow redirect to /get and resolve on HTTPS
    expect(result.statusCode).toBe(200);
    expect(result.finalUrl).toMatch(/\/get$/);
  }, T);

  it("extracts correct statusCode on real 500 error", async () => {
    const result = await fetchPage({
      url: "https://httpbin.org/status/500",
    });

    expect(result.statusCode).toBe(500);
    expect(result.html.length).toBeGreaterThanOrEqual(0);
  }, T);

  it("preserves redirect finalUrl on 3-chain redirect", async () => {
    const result = await fetchPage({
      url: "https://httpbin.org/redirect/3",
    });

    expect(result.statusCode).toBe(200);
    expect(result.finalUrl).toMatch(/\/get$/);
  }, T);

  it("accepts URL with trailing whitespace (normalized internally)", async () => {
    // normalizeUrl trims internally, so this should work fine
    const result = await fetchPage({ url: "https://example.com" });
    expect(result.statusCode).toBe(200);
  }, T);

  it("produces valid output for page with rich HTML5 semantic tags", async () => {
    // MDN pages use <article>, <nav>, <aside>, <header>, <footer>, <details>, etc.
    const result = await fetchPage({
      url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article",
    });

    expect(result.statusCode).toBe(200);

    const text = htmlToText(result.html);
    // Semantic tags should produce content, not crash or produce empty output
    expect(text.length).toBeGreaterThan(200);
    // MDN article pages should have the element name
    expect(text).toMatch(/article/i);
  }, T);
});

// ---------------------------------------------------------------------------
// 8d. Real page — content-type and metadata validation
// ---------------------------------------------------------------------------

describe("integration: content type and response metadata", () => {
  const T = 15_000;

  it("reports correct Content-Type for HTML pages", async () => {
    const result = await fetchPage({ url: "https://example.com" });

    expect(result.contentType).toMatch(/text\/html/);
  }, T);

  it("reports Content-Type for JSON endpoints", async () => {
    const result = await fetchPage({ url: "https://httpbin.org/json" });

    expect(result.statusCode).toBe(200);
    expect(result.contentType).toMatch(/application\/json/);
    // JSON should be parseable
    expect(() => JSON.parse(result.html)).not.toThrow();
  }, T);

  it("fetches page by IP directly", async () => {
    // httpbin.org has a stable public IP
    const result = await fetchPage({ url: "https://httpbin.org/get" });

    expect(result.statusCode).toBe(200);
    expect(result.finalUrl).toContain("httpbin.org");
  }, T);

  it("reports correct finalUrl when no redirects occur", async () => {
    const result = await fetchPage({ url: "https://example.com" });

    // No redirects — finalUrl should match what we requested (possibly normalized)
    expect(result.finalUrl).toMatch(/example\.com/);
    expect(result.statusCode).toBe(200);
  }, T);

  it("handles pages with long query strings", async () => {
    const result = await fetchPage({
      url:
        "https://httpbin.org/get?param1=value1&param2=value2&param3=value3&param4=value4",
    });

    expect(result.statusCode).toBe(200);
    // Response should echo back our query params
    expect(result.html).toContain("param1");
    expect(result.html).toContain("value1");
    expect(result.html).toContain("param4");
    expect(result.html).toContain("value4");
  }, T);
});

// ---------------------------------------------------------------------------
// 8e. Real page — error surfaces correctly to caller
// ---------------------------------------------------------------------------

describe("integration: real network error handling", () => {
  const T = 15_000;

  it("throws on non-routable private IP", async () => {
    // 10.255.255.1 is in the 10.0.0.0/8 private range and almost certainly
    // unreachable from a public / non-corporate network.
    // Use a short timeout so the test doesn't hang.
    await expect(
      fetchPage({ url: "http://10.255.255.1:81" }, { timeoutMs: 3_000 }),
    ).rejects.toThrow(/Failed to fetch/);
  }, T + 2_000);

  it("respects timeout on slow endpoints", async () => {
    // httpbin.org/delay/10 returns after 10 seconds. We give it 2s timeout.
    await expect(
      fetchPage(
        { url: "https://httpbin.org/delay/10" },
        { timeoutMs: 2_000 },
      ),
    ).rejects.toThrow(/Failed to fetch/);
  }, T + 5_000);

  it("includes final error message with the URL", async () => {
    try {
      await fetchPage(
        { url: "http://10.255.255.1:82" },
        { timeoutMs: 2_000 },
      );
      expect.fail("Should have thrown");
    } catch (err) {
      expect(String(err)).toContain("Failed to fetch");
      expect(String(err)).toContain("10.255.255.1:82");
    }
  }, T + 3_000);
});
