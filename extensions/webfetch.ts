/**
 * Local web fetch for LLMs, backed by agent-browser (real Chromium, no cloud).
 *
 * Two tools:
 * - web_fetch: readable text / raw source / heading outline, with auto fallback
 *   from the HTTP fast path to a rendered browser page (beats JS bot-walls).
 * - web_interact: drive a page (goto, snapshot, click, fill, press, scroll,
 *   screenshot) when a plain fetch is not enough.
 *
 * Nothing leaves the machine except Chromium talking to the fetched site:
 * the Vercel AI Gateway env vars are stripped from every child process.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const SESSION = "pi-webfetch";
const BROWSERS = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
const STRIP_ENV = ["AI_GATEWAY_API_KEY", "AI_GATEWAY_URL", "AI_GATEWAY_MODEL"];
const MAX_CHARS_DEFAULT = 20000;
const HTTP_TIMEOUT_MS = 20000;
const BROWSER_TIMEOUT_MS = 90000;

const BOT_WALL = /making sure you're not a bot|oh noes!|just a moment|checking your browser|verify you are human|attention required|enable javascript|pardon our interruption|error code [0-9a-f]{12,}/i;

interface FetchDetails {
  action: string;
  url: string;
  status?: number;
  rendered?: boolean;
  chars?: number;
  truncated?: boolean;
  savedTo?: string;
  error?: string;
}

interface CliJson {
  success?: boolean;
  error?: string;
  data?: {
    content?: string;
    contentType?: string;
    status?: number;
    url?: string;
    finalUrl?: string;
    truncated?: boolean;
    origin?: string;
  };
}

function profileDir(): string {
  const dir = process.env.PI_WEBFETCH_PROFILE?.trim() || join(homedir(), ".pi/agent/data/webfetch-profile");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cliBin(): string {
  const override = process.env.PI_WEBFETCH_BIN?.trim();
  if (override) return override;
  const home = homedir();
  const candidates = [
    join(home, ".npm-global/bin/agent-browser"),
    "/usr/local/bin/agent-browser",
    "/run/current-system/sw/bin/agent-browser",
  ];
  return candidates.find((path) => existsSync(path)) ?? "agent-browser";
}

function detectBrowser(): string | undefined {
  const override = process.env.PI_WEBFETCH_BROWSER?.trim();
  if (override) return override;
  const configured = process.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim();
  if (configured) return configured;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    for (const name of BROWSERS) {
      const path = join(dir, name);
      if (dir && existsSync(path)) return realpath(path);
    }
  }
  return undefined;
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

let browserVersion: Promise<string | undefined> | undefined;

function chromeMajor(browser: string): Promise<string | undefined> {
  browserVersion ??= run(browser, ["--version"], { env: { ...process.env }, timeoutMs: 5000 })
    .then(({ stdout }) => /(?:Chrome|Chromium)[/\s]+(\d+)/.exec(stdout)?.[1])
    .catch(() => undefined);
  return browserVersion;
}

function platformToken(): string {
  if (process.platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  return process.arch === "arm64" ? "X11; Linux aarch64" : "X11; Linux x86_64";
}

let childEnvPromise: Promise<NodeJS.ProcessEnv> | undefined;

/** Env for every agent-browser run: local browser, non-headless UA, no AI Gateway. */
function childEnv(): Promise<NodeJS.ProcessEnv> {
  childEnvPromise ??= (async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of STRIP_ENV) delete env[key];
    const browser = detectBrowser();
    if (browser) env.AGENT_BROWSER_EXECUTABLE_PATH = browser;
    const version = env.AGENT_BROWSER_USER_AGENT ? undefined : browser ? await chromeMajor(browser) : undefined;
    if (version) {
      // Headless Chrome reports "HeadlessChrome/..." and bot-walls reject that outright.
      env.AGENT_BROWSER_USER_AGENT = `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
    }
    if (!env.AGENT_BROWSER_IDLE_TIMEOUT_MS) env.AGENT_BROWSER_IDLE_TIMEOUT_MS = "120000";
    return env;
  })();
  return childEnvPromise;
}

interface RunOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: options.env });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => fail(new Error(`Timed out after ${Math.round(options.timeoutMs / 1000)}s`)), options.timeoutMs);
    const onAbort = () => fail(new Error("Cancelled"));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    function fail(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      rejectRun(error);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        fail(new Error(`agent-browser not found. Install: npm install -g agent-browser (or set PI_WEBFETCH_BIN)`));
        return;
      }
      fail(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolveRun({ stdout, stderr, code: code ?? 0 });
    });
  });
}

async function callCli(args: string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<RunResult> {
  const env = await childEnv();
  const result = await run(cliBin(), ["--session", SESSION, "--profile", profileDir(), ...args], {
    env,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (result.code !== 0) {
    const payload = parseJson(result.stdout);
    const message = payload?.error ?? `${result.stderr}\n${result.stdout}`.trim();
    throw new Error(clean(message, 600) || `agent-browser exited ${result.code}`);
  }
  return result;
}

function parseJson(stdout: string): CliJson | undefined {
  try {
    return JSON.parse(stdout) as CliJson;
  } catch {
    return undefined;
  }
}

async function callJson(args: string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<NonNullable<CliJson["data"]>> {
  const { stdout } = await callCli([...args, "--json"], options);
  const payload = parseJson(stdout);
  if (!payload) throw new Error(`Unexpected agent-browser output: ${clean(stdout, 200)}`);
  if (payload.success === false) throw new Error(clean(payload.error ?? "agent-browser reported a failure", 400));
  return payload.data ?? {};
}

function readFlags(format: Format, filter?: string): string[] {
  const flags = format === "html" ? ["--raw"] : format === "outline" ? ["--outline"] : [];
  return filter?.trim() ? [...flags, "--filter", filter.trim()] : flags;
}

async function fetchHttp(url: string, format: Format, filter: string | undefined, signal: AbortSignal | undefined) {
  const data = await callJson(["read", url, ...readFlags(format, filter)], { timeoutMs: HTTP_TIMEOUT_MS, signal });
  return { data, rendered: false };
}

async function fetchRendered(url: string, format: Format, filter: string | undefined, waitFor: string | undefined, signal: AbortSignal | undefined) {
  await callCli(["open", url], { timeoutMs: BROWSER_TIMEOUT_MS, signal });
  if (waitFor?.trim()) {
    await callCli(["wait", "--text", waitFor.trim()], { timeoutMs: BROWSER_TIMEOUT_MS, signal });
  }
  const data = await callJson(["read", ...readFlags(format, filter)], { timeoutMs: BROWSER_TIMEOUT_MS, signal });
  return { data, rendered: true };
}

/** Decide whether the HTTP body is a bot challenge or a JavaScript shell rather than the real page. */
function needsRender(content: string): boolean {
  return content.trim().length === 0 || BOT_WALL.test(content);
}

/**
 * auto: HTTP first, rendered page when the body is a challenge/shell or the plain
 * request failed. Some firewalls answer non-browsers with 4xx and a browser fine.
 */
async function fetchAuto(
  url: string,
  format: Format,
  filter: string | undefined,
  waitFor: string | undefined,
  signal: AbortSignal | undefined,
) {
  let httpError: unknown;
  try {
    const viaHttp = await fetchHttp(url, format, filter, signal);
    if (format !== "text" || !needsRender(viaHttp.data.content ?? "")) return viaHttp;
  } catch (err) {
    httpError = err;
  }
  try {
    return await fetchRendered(url, format, filter, waitFor, signal);
  } catch (renderError) {
    if (!httpError) throw renderError;
    throw new Error(`${errMessage(httpError)} (browser render failed: ${errMessage(renderError)})`);
  }
}

function clean(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function clampChars(value: number | undefined): number {
  return value && value > 0 ? Math.min(200000, Math.trunc(value)) : MAX_CHARS_DEFAULT;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

function normalizeUrl(value: string): string {
  const url = value.trim();
  if (!url) throw new Error("URL cannot be empty");
  if (!/^https?:\/\//i.test(url)) return `https://${url}`;
  return url;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a URL locally with a real browser: readable text, raw source, or heading outline",
    promptSnippet: "Fetch a URL (readable text / raw html / outline), rendering with headless Chromium when the site is behind a JS bot-wall (Anubis, Cloudflare)",
    promptGuidelines: [
      "Use web_fetch to read page content; web_search returns snippets only.",
      "Default mode=auto is enough: it tries the fast HTTP path and re-fetches through the browser when the site serves a bot challenge.",
      "Use format=html for the full source, format=outline for a cheap heading map of a long page, filter=… to pull only matching sections.",
      "Use save_to=… when the page must be inspected in chunks; then read the saved file with the read tool.",
      "If a page needs clicks or typing, switch to web_interact.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch (https:// added when omitted)" }),
      format: Type.Optional(Type.Union([
        Type.Literal("text"),
        Type.Literal("html"),
        Type.Literal("outline"),
      ], { description: "text = readable text (default), html = raw response body, outline = heading outline" })),
      mode: Type.Optional(Type.Union([
        Type.Literal("auto"),
        Type.Literal("http"),
        Type.Literal("browser"),
      ], { description: "auto = HTTP then browser on bot-wall (default), http = never render, browser = always render" })),
      filter: Type.Optional(Type.String({ description: "Return only sections matching this text" })),
      wait_for: Type.Optional(Type.String({ description: "Rendered mode only: wait for this text to appear before reading" })),
      max_chars: Type.Optional(Type.Number({ description: `Truncate output at N characters (default ${MAX_CHARS_DEFAULT})` })),
      save_to: Type.Optional(Type.String({ description: "Write the result to this path instead of returning it in full" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const url = normalizeUrl(params.url);
      const format = (params.format ?? "text") as Format;
      const mode = params.mode ?? "auto";
      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${hostOf(url)} (${mode}/${format})...` }],
        details: { action: "fetch", url },
      });

      let data: NonNullable<CliJson["data"]>;
      let rendered = false;
      try {
        const fetched = mode === "browser"
          ? await fetchRendered(url, format, params.filter, params.wait_for, signal)
          : mode === "http"
            ? await fetchHttp(url, format, params.filter, signal)
            : await fetchAuto(url, format, params.filter, params.wait_for, signal);
        data = fetched.data;
        rendered = fetched.rendered;
      } catch (err) {
        const details: FetchDetails = { action: "fetch", url, error: clean(errMessage(err), 300) };
        if (signal?.aborted) return { content: [{ type: "text", text: "Fetch cancelled." }], details: { ...details, error: undefined } };
        throw err instanceof Error ? err : new Error(String(err));
      }

      const body = cleanNewlines(data.content ?? "");
      const finalUrl = data.finalUrl || data.url || url;
      if (params.save_to?.trim()) {
        const path = isAbsolute(params.save_to.trim()) ? params.save_to.trim() : resolve(ctx.cwd, params.save_to.trim());
        writeFileSyncSafe(path, body);
        const preview = body.slice(0, 800);
        return {
          content: [{ type: "text", text: `Saved ${body.length} chars to ${path}\n\n${preview}${body.length > preview.length ? "\n…" : ""}` }],
          details: { action: "fetch", url, finalUrl, status: data.status, rendered, chars: body.length, savedTo: path },
        };
      }

      const limit = clampChars(params.max_chars);
      const truncated = body.length > limit;
      const text = truncated ? `${body.slice(0, limit)}\n\n[… truncated at ${limit} of ${body.length} chars; re-run with filter=… or save_to=…]` : body;

      return {
        content: [{ type: "text", text }],
        details: { action: "fetch", url: finalUrl, status: data.status, rendered, chars: body.length, truncated },
      };
    },

    renderCall(args, theme) {
      const url = clean(String(args.url ?? ""), 60);
      const format = args.format && args.format !== "text" ? theme.fg("muted", ` ${args.format}`) : "";
      const mode = args.mode && args.mode !== "auto" ? theme.fg("dim", ` ${args.mode}`) : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", url) + format + mode,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, context) {
      const details = result.details as FetchDetails | undefined;
      if (details?.error || context.isError) {
        const message = details?.error ?? result.content.find((c) => c.type === "text")?.text ?? "Unknown error";
        return new Text(theme.fg("error", `Error: ${clean(message, 200)}`), 0, 0);
      }
      const chars = details?.chars ?? 0;
      let status = theme.fg("success", `${formatChars(chars)}`);
      status += theme.fg("dim", ` ${details?.rendered ? "rendered" : "http"}`);
      if (details?.status) status += theme.fg("dim", ` ${details.status}`);
      if (details?.savedTo) status += theme.fg("dim", ` → ${details.savedTo}`);
      else if (details?.truncated) status += theme.fg("warning", " (truncated)");
      if (!expanded) return new Text(status, 0, 0);
      const text = result.content.find((c) => c.type === "text")?.text ?? "";
      return new Text(`${status}\n${theme.fg("dim", clean(text, 800))}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "web_interact",
    label: "Web Interact",
    description: "Drive a rendered browser page: navigate, snapshot, click, fill, press, scroll, screenshot",
    promptSnippet: "Drive a headless Chromium page when clicking or typing is required (snapshot gives @refs for targets)",
    promptGuidelines: [
      "web_interact acts on one shared session: goto first, then snapshot -i to get @refs, then act on those refs.",
      "Take a fresh snapshot after navigation or any layout change; refs go stale otherwise.",
      "Prefer web_fetch for reading content; use web_interact only when interaction is required.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("goto"),
        Type.Literal("snapshot"),
        Type.Literal("click"),
        Type.Literal("fill"),
        Type.Literal("press"),
        Type.Literal("scroll"),
        Type.Literal("text"),
        Type.Literal("screenshot"),
        Type.Literal("close"),
      ], { description: "goto=navigate, snapshot=a11y tree with @refs, click/fill/press/scroll=act, text=read current page, screenshot=viewport image, close=release browser" }),
      url: Type.Optional(Type.String({ description: "URL for goto" })),
      target: Type.Optional(Type.String({ description: "Ref from snapshot (@e12) or CSS selector, for click/fill/screenshot" })),
      value: Type.Optional(Type.String({ description: "Text for fill, key name for press (e.g. Enter)" })),
      direction: Type.Optional(Type.Union([
        Type.Literal("up"),
        Type.Literal("down"),
        Type.Literal("left"),
        Type.Literal("right"),
      ], { description: "Scroll direction (default down)" })),
      pixels: Type.Optional(Type.Number({ description: "Scroll amount in pixels (default 600)" })),
      urls: Type.Optional(Type.Boolean({ description: "snapshot: include link hrefs" })),
      full_page: Type.Optional(Type.Boolean({ description: "screenshot: capture the whole page" })),
      max_chars: Type.Optional(Type.Number({ description: `Truncate returned text at N characters (default ${MAX_CHARS_DEFAULT})` })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const action = params.action as InteractAction;
      onUpdate?.({ content: [{ type: "text", text: `web_interact: ${action}...` }], details: { action } });

      try {
        if (action === "goto") {
          if (!params.url?.trim()) throw new Error("url is required for goto");
          await callCli(["open", normalizeUrl(params.url)], { timeoutMs: BROWSER_TIMEOUT_MS, signal });
          const data = await callJson(["read"], { timeoutMs: BROWSER_TIMEOUT_MS, signal });
          const body = cleanNewlines(data.content ?? "");
          const limit = clampChars(params.max_chars);
          return {
            content: [{ type: "text", text: body.slice(0, limit) }],
            details: { action, url: data.finalUrl ?? params.url, rendered: true, chars: body.length },
          };
        }

        if (action === "snapshot") {
          const args = ["snapshot", "-i", ...(params.urls ? ["-u"] : [])];
          const { stdout } = await callCli(args, { timeoutMs: BROWSER_TIMEOUT_MS, signal });
          const body = cleanNewlines(stdout);
          const limit = clampChars(params.max_chars);
          return {
            content: [{ type: "text", text: body.slice(0, limit) }],
            details: { action, rendered: true, chars: body.length },
          };
        }

        if (action === "click") {
          requireTarget(params.target, "click");
          await callCli(["click", params.target!.trim()], { timeoutMs: BROWSER_TIMEOUT_MS, signal });
          return ack(`clicked ${params.target!.trim()}`, action);
        }

        if (action === "fill") {
          requireTarget(params.target, "fill");
          if (!params.value) throw new Error("value is required for fill");
          await callCli(["fill", params.target!.trim(), params.value], { timeoutMs: BROWSER_TIMEOUT_MS, signal });
          return ack(`filled ${params.target!.trim()}`, action);
        }

        if (action === "press") {
          if (!params.value?.trim()) throw new Error("value (key name) is required for press");
          await callCli(["press", params.value.trim()], { timeoutMs: BROWSER_TIMEOUT_MS, signal });
          return ack(`pressed ${params.value.trim()}`, action);
        }

        if (action === "scroll") {
          const direction = params.direction ?? "down";
          const pixels = params.pixels && params.pixels > 0 ? Math.trunc(params.pixels) : 600;
          await callCli(["scroll", direction, String(pixels)], { timeoutMs: BROWSER_TIMEOUT_MS, signal });
          return ack(`scrolled ${direction} ${pixels}px`, action);
        }

        if (action === "screenshot") {
          const file = join(tmpdir(), `pi-webfetch-${Date.now()}.png`);
          try {
            await callCli(["screenshot", ...(params.full_page ? ["--full"] : []), ...(params.target?.trim() ? [params.target.trim()] : []), file], { timeoutMs: BROWSER_TIMEOUT_MS, signal });
            const data = readFileSync(file).toString("base64");
            return {
              content: [
                { type: "text", text: `Screenshot of the rendered page (${Math.round(data.length / 1024)} KB base64 PNG)` },
                { type: "image", data, mimeType: "image/png" },
              ],
              details: { action, rendered: true },
            };
          } finally {
            rmSync(file, { force: true });
          }
        }

        if (action === "close") {
          await callCli(["close"], { timeoutMs: 30000, signal });
          return ack("browser released", action);
        }

        const data = await callJson(["read"], { timeoutMs: BROWSER_TIMEOUT_MS, signal });
        const body = cleanNewlines(data.content ?? "");
        const limit = clampChars(params.max_chars);
        return {
          content: [{ type: "text", text: body.slice(0, limit) }],
          details: { action, url: data.finalUrl, rendered: true, chars: body.length },
        };
      } catch (err) {
        if (signal?.aborted) return { content: [{ type: "text", text: "Interaction cancelled." }], details: { action } };
        throw err instanceof Error ? err : new Error(String(err));
      }
    },

    renderCall(args, theme) {
      const action = clean(String(args.action ?? ""), 20);
      const target = args.target ? theme.fg("muted", ` ${clean(String(args.target), 30)}`) : args.url ? theme.fg("muted", ` ${clean(String(args.url), 30)}`) : "";
      return new Text(theme.fg("toolTitle", theme.bold("web_interact ")) + theme.fg("accent", action) + target, 0, 0);
    },

    renderResult(result, { expanded }, theme, context) {
      const details = result.details as FetchDetails | undefined;
      if (context.isError) {
        const message = result.content.find((c) => c.type === "text")?.text ?? "Unknown error";
        return new Text(theme.fg("error", `Error: ${clean(message, 200)}`), 0, 0);
      }
      const chars = details?.chars;
      const status = chars ? theme.fg("success", `${formatChars(chars)} read`) : theme.fg("success", "done");
      if (!expanded) return new Text(status, 0, 0);
      const text = result.content.find((c) => c.type === "text")?.text ?? "";
      return new Text(`${status}\n${theme.fg("dim", clean(text, 600))}`, 0, 0);
    },
  });
}

type Format = "text" | "html" | "outline";
type InteractAction = "goto" | "snapshot" | "click" | "fill" | "press" | "scroll" | "text" | "screenshot" | "close";

function ack(text: string, action: string) {
  return { content: [{ type: "text" as const, text }], details: { action, rendered: true } };
}

function requireTarget(target: string | undefined, action: string): void {
  if (!target?.trim()) throw new Error(`target (a @ref from snapshot or a CSS selector) is required for ${action}`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function writeFileSyncSafe(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function cleanNewlines(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function formatChars(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k chars` : `${chars} chars`;
}
