import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_BASE_URL = "http://127.0.0.1:7777";
const PAGE_SIZE = 10;
const MAX_PAGE = 10;
const TIMEOUT_MS = 20000;
const SNIPPET_LIMIT = 400;

interface SearxResult {
  url?: string;
  title?: string;
  content?: string;
  engine?: string;
  engines?: string[];
  publishedDate?: string | null;
}

interface SearxResponse {
  query?: string;
  results?: SearxResult[];
  unresponsive_engines?: Array<[string, string]>;
}

interface SearchDetails {
  query: string;
  page: number;
  returned: number;
  possiblyMore?: boolean;
  url?: string;
  cancelled?: boolean;
}

function baseUrl(): string {
  const raw = (process.env.SEARXNG_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(`Invalid SEARXNG_URL "${raw}" (expected http:// or https://)`);
  }
  return raw;
}

function linkSignals(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function clean(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function publishedText(value: SearxResult["publishedDate"]): string {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

function resultKey(result: SearxResult): string {
  try {
    const url = new URL(result.url as string);
    return `${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`.toLowerCase();
  } catch {
    return `title:${result.title ?? ""}`;
  }
}

function collectResults(results: SearxResult[]): SearxResult[] {
  const seen = new Set<string>();
  const out: SearxResult[] = [];
  for (const result of results) {
    if (!result?.url && !result?.title) continue;
    const key = resultKey(result);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
    if (out.length >= PAGE_SIZE) break;
  }
  return out;
}

function formatResults(query: string, page: number, results: SearxResult[], response: SearxResponse): string {
  const lines: string[] = [];
  const engineErrors = Array.isArray(response.unresponsive_engines) ? response.unresponsive_engines : [];

  if (results.length === 0) {
    lines.push(`No results for "${query}" on page ${page}.`);
  } else {
    results.forEach((result, index) => {
      const title = clean(result.title, 120) || clean(result.url, 120) || "Untitled result";
      lines.push(`${index + 1}. ${title}`);
      if (result.url) lines.push(`   ${result.url}`);
      const snippet = clean(result.content, SNIPPET_LIMIT);
      if (snippet) lines.push(`   ${snippet}`);
      const engines = Array.isArray(result.engines) && result.engines.length
        ? result.engines.join(", ")
        : clean(result.engine, 60);
      const date = publishedText(result.publishedDate);
      const meta = [engines && `via ${engines}`, date && `published ${date}`].filter(Boolean).join(" | ");
      if (meta) lines.push(`   (${meta})`);
      lines.push("");
    });
  }

  if (results.length === PAGE_SIZE) {
    lines.push(`Page ${page} is full (${PAGE_SIZE} shown). Call web_search again with page=${page + 1} for the next page.`);
  }
  if (engineErrors.length > 0) {
    lines.push(`Unresponsive engines: ${engineErrors.map(([engine, error]) => `${engine} (${error})`).join(", ")}`);
  }

  return lines.join("\n").trim();
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web via the self-hosted SearXNG instance",
    promptSnippet: "Search the web via self-hosted SearXNG; returns one page of up to 10 aggregated results",
    promptGuidelines: [
      "Use web_search when current web information would help answer the user's request.",
      "web_search returns one page of up to 10 results per call; page through with the page parameter instead of rephrasing the query.",
      "web_search gives snippets only; fetch a page body with bash and curl.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      page: Type.Optional(Type.Number({
        description: `Result page, 1-based (1 request per page, max ${MAX_PAGE}); default: 1`,
        minimum: 1,
        maximum: MAX_PAGE,
      })),
      categories: Type.Optional(Type.String({
        description: "Comma-separated SearXNG categories (general, news, it, images, videos, ...); default: general",
      })),
      language: Type.Optional(Type.String({
        description: "Result language code (en, pl, de, ...); default: instance default",
      })),
      time_range: Type.Optional(Type.Union([
        Type.Literal("day"),
        Type.Literal("week"),
        Type.Literal("month"),
        Type.Literal("year"),
      ], { description: "Restrict results to the last day, week, month or year" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const query = params.query?.trim();
      if (!query) throw new Error("Query cannot be empty");

      const page = Math.min(MAX_PAGE, Math.max(1, Math.trunc(params.page ?? 1)));
      const base = baseUrl();
      const url = new URL("search", `${base}/`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("pageno", String(page));
      url.searchParams.set("categories", params.categories?.trim() || "general");
      if (params.language?.trim()) url.searchParams.set("language", params.language.trim());
      if (params.time_range) url.searchParams.set("time_range", params.time_range);

      onUpdate?.({
        content: [{ type: "text", text: `Searching SearXNG for "${query}" (page ${page})...` }],
        details: { query, page, returned: 0 },
      });

      const linked = linkSignals(signal, TIMEOUT_MS);
      try {
        const response = await fetch(url, { signal: linked.signal, headers: { Accept: "application/json" } });
        const text = await response.text();

        if (!response.ok) {
          if (response.status === 403) {
            throw new Error(`SearXNG refused the request (403): add "json" to search.formats on ${base}`);
          }
          throw new Error(`SearXNG HTTP ${response.status} from ${base}: ${clean(text, 200) || response.statusText}`);
        }

        let payload: SearxResponse;
        try {
          payload = JSON.parse(text) as SearxResponse;
        } catch {
          throw new Error(`SearXNG returned a non-JSON response from ${base} (is search.formats set?)`);
        }

        const results = collectResults(Array.isArray(payload.results) ? payload.results : []);
        const output = formatResults(query, page, results, payload);

        return {
          content: [{ type: "text", text: output }],
          details: { query, page, returned: results.length, possiblyMore: results.length === PAGE_SIZE, url: url.toString() },
        };
      } catch (err) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Search cancelled." }], details: { query, page, returned: 0, cancelled: true } };
        }
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          throw new Error(`SearXNG request timed out after ${TIMEOUT_MS / 1000}s: ${base}`);
        }
        throw err instanceof Error ? err : new Error(String(err));
      } finally {
        linked.cleanup();
      }
    },

    renderCall(args, theme) {
      const query = clean(String(args.query ?? ""), 50);
      const page = Math.max(1, Math.trunc(args.page ?? 1));
      const pageSuffix = page > 1 ? theme.fg("muted", ` p${page}`) : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", `"${query}"`) + pageSuffix,
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = result.details as SearchDetails | undefined;

      if (isPartial) return new Text(theme.fg("accent", "Searching..."), 0, 0);
      if (details?.cancelled) return new Text(theme.fg("muted", "Cancelled"), 0, 0);

      if (context.isError) {
        const message = result.content.find((c) => c.type === "text")?.text || "Unknown error";
        return new Text(theme.fg("error", `Error: ${clean(message, 200)}`), 0, 0);
      }

      const count = details?.returned ?? 0;
      let status = theme.fg("success", `${count} ${count === 1 ? "result" : "results"}`);
      if (details) status += theme.fg("dim", ` (page ${details.page}${details.possiblyMore ? "+" : ""})`);

      if (!expanded) return new Text(status, 0, 0);

      const text = result.content.find((c) => c.type === "text")?.text || "";
      return new Text(`${status}\n${theme.fg("dim", clean(text, 600))}`, 0, 0);
    },
  });
}
