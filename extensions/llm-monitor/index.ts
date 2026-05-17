/**
 * LLM Monitor Extension
 *
 * Monitors llama-server (llm-router.service) logs via journalctl
 * and displays real-time prompt processing progress and token generation speed.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";
import {
  createIdleStats,
  deriveStats,
  parseLine,
  processEvents,
  renderDashboard,
  renderFooterStatus,
  RequestPhase,
} from "./llm-monitor-lib.js";

// ─── Configuration ──────────────────────────────────────────

const SERVICE_NAME = "llm-router.service";
const WIDGET_ID = "llm-monitor";
const FOOTER_ID = "llm-monitor";
const UPDATE_INTERVAL_MS = 300;

// ─── Extension State ────────────────────────────────────────

let requestState: ReturnType<typeof processEvents> | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;
let logProcess: ReturnType<typeof spawn> | null = null;

// ─── Log Stream Management ──────────────────────────────────

function startLogStream(ctx: ExtensionContext): void {
  stopLogStream();

  try {
    logProcess = spawn("journalctl", [
      "-u",
      SERVICE_NAME,
      "--no-pager",
      "--follow",
      "--since",
      "now",
    ]);
    if (!logProcess.stdout) return;

    let partialLine = "";
    logProcess.stdout.on("data", (chunk: Buffer) => {
      partialLine += chunk.toString();
      const lines = partialLine.split("\n");
      partialLine = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim()) processLogLine(line);
      }
    });

    logProcess.on("exit", (code) => {
      if (code !== null && code !== 0) {
        ctx.ui.notify(
          `llm-monitor: journalctl exited with code ${code}`, "error"
        );
      }
    });

    logProcess.on("error", (err) => {
      ctx.ui.notify(`llm-monitor: journalctl error (${err})`, "error");
    });

    startUpdateLoop(ctx);
  } catch (err) {
    ctx.ui.notify(`llm-monitor: Cannot spawn journalctl (${err})`, "error");
  }
}

function stopLogStream(): void {
  if (logProcess) {
    logProcess.kill("SIGTERM");
  }
  if (updateInterval) {
    clearInterval(updateInterval);
  }
  logProcess = null;
  updateInterval = null;
}

function startUpdateLoop(ctx: ExtensionContext): void {
  if (updateInterval) return;
  updateInterval = setInterval(() => updateUI(ctx), UPDATE_INTERVAL_MS);
}

// ─── Event Processing Pipeline ──────────────────────────────

let currentCtx: ExtensionContext | null = null;

function processLogLine(rawLine: string): void {
  const events = parseLine(rawLine);
  if (events.length === 0) return;

  if (!requestState) {
    requestState = {
      phase: RequestPhase.IDLE,
      taskId: null,
      slotId: null,
      requestStartTime: null,
      promptTokensTotal: null,
      promptTokensSeen: 0,
      promptSpeed: 0,
      promptElapsedMs: 0,
      generatedTokensTotal: 0,
      generationSpeed: 0,
      generationStartTime: null,
    };
  }

  requestState = processEvents(requestState, events, Date.now());
  updateUI(currentCtx!);
}

// ─── UI Update ──────────────────────────────────────────────

function updateUI(ctx: ExtensionContext): void {
  const stats = requestState ? deriveStats(requestState) : createIdleStats();

  // Bind theme.fg to preserve `this` context (Theme.fg uses this.fgColors internally)
  const safeTheme = ctx.ui.theme
    ? { fg: (color: string, text: string) => ctx.ui.theme!.fg(color, text) }
    : undefined;

  ctx.ui.setWidget(WIDGET_ID, renderDashboard(stats, safeTheme), {
    placement: "belowEditor",
  });
  ctx.ui.setStatus(FOOTER_ID, renderFooterStatus(stats, safeTheme));
}



// ─── Extension Entry Point ──────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    requestState = null;
    startLogStream(ctx);
    ctx.ui.notify("llm-monitor: Started watching llm-router.service", "info");
  });

  pi.on("session_shutdown", () => {
    stopLogStream();
    currentCtx = null;
  });

  // ── Commands ───────────────────────────────────────────────

  pi.registerCommand("llm-monitor", {
    description: "Monitor LLM server (toggle widget on/off)",
    handler: async (_args, ctx) => {
      if (updateInterval || logProcess) {
        stopLogStream();
        ctx.ui.setWidget(WIDGET_ID, undefined);
        ctx.ui.setStatus(FOOTER_ID, undefined);
        ctx.ui.notify("llm-monitor: Stopped", "info");
      } else {
        startLogStream(ctx);
        ctx.ui.notify("llm-monitor: Started", "info");
      }
    },
  });

  pi.registerCommand("llmmon", {
    description: "Show current LLM monitor status as a notification",
    handler: async (_args, ctx) => {
      if (!requestState) {
        ctx.ui.notify("llm-monitor: No active request (idle)", "info");
        return;
      }

      const stats = deriveStats(requestState);
      let lines: string[] = [];

      switch (stats.phase) {
        case RequestPhase.PROMPT_EVAL:
          lines.push(`Phase: Prompt evaluation`);
          lines.push(`Tokens seen: ${stats.promptTokensSeen}`);
          if (stats.promptTokensTotal)
            lines.push(`Estimated total: ${stats.promptTokensTotal}`);
          lines.push(`Speed: ${stats.promptSpeed} tok/s`);
          break;

        case RequestPhase.GENERATION:
          lines.push(`Phase: Token generation`);
          lines.push(`Tokens generated: ${stats.generatedTokensTotal}`);
          lines.push(`Speed: ${stats.generationSpeed} tok/s`);
          break;

        case RequestPhase.COMPLETE:
          lines.push("Phase: Complete");
          if (stats.promptSpeed > 0) {
            lines.push(`Prompt tokens: ${stats.promptTokensSeen}`);
          }
          if (stats.generatedTokensTotal > 0) {
            lines.push(`Generated: ${stats.generatedTokensTotal} tok`);
          }
          break;

        default:
          lines.push("Status: Idle");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
