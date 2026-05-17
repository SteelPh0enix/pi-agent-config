/**
 * LLM Monitor - Library (pure logic)
 *
 * All parsing, state machine, and dashboard rendering logic extracted
 * into this single module so it can be imported by tests without
 * the Pi extension framework.
 */

// ─── Types ──────────────────────────────────────────────────

export enum RequestPhase {
  IDLE = "idle",
  PROMPT_EVAL = "prompt_eval",
  GENERATION = "generation",
  COMPLETE = "complete",
}

/** Parsed from a "prompt processing" print_timing line */
export interface PromptProcessingEvent {
  type: "prompt_processing";
  taskId: number;
  slotId: number | null;
  nTokens: number;
  progress: number;
  elapsedSeconds: number;
  tokensPerSecond: number;
  timestamp: number;
}

/** Parsed from a "n_decoded" print_timing line */
export interface GenerationEvent {
  type: "generation";
  taskId: number | null;
  slotId: number | null;
  nDecoded: number;
  tokensPerSecond: number;
  timestamp: number;
}

/** Parsed from final summary lines */
export interface SummaryLine {
  type: "prompt_eval_summary" | "generation_summary" | "total_summary";
  taskId: number | null;
  slotId: number | null;
  promptEvalTimeMs: number;
  promptEvalTokens: number;
  promptEvalMsPerToken: number;
  promptEvalTps: number;
  generationTimeMs: number;
  generationTokens: number;
  generationMsPerToken: number;
  generationTps: number;
  totalTimeMs: number;
  totalTokens: number;
}

/** Parsed from release line */
export interface ReleaseEvent {
  type: "release";
  taskId: number;
  slotId: number;
  nTokens: number;
  truncated: boolean;
}

/** Parsed from "all slots are idle" */
export interface IdleEvent {
  type: "idle";
  timestamp: number;
}

/** Parsed from "launch_slot_" line — earliest sign a request is running */
export interface LaunchEvent {
  type: "launch";
  taskId: number;
  slotId: number | null;
}

export type LogEvent =
  | PromptProcessingEvent
  | GenerationEvent
  | SummaryLine
  | ReleaseEvent
  | IdleEvent
  | LaunchEvent;

/** Internal state tracked through a single request lifecycle */
export interface LLMRequestState {
  phase: RequestPhase;
  taskId: number | null;
  slotId: number | null;

  // Timing
  requestStartTime: number | null; // timestamp of first event for this request

  // Prompt eval tracking (known progress)
  promptTokensTotal: number | null;
  promptTokensSeen: number;
  promptSpeed: number;
  promptElapsedMs: number;

  // Generation tracking (unknown total)
  generatedTokensTotal: number;
  generationSpeed: number;
  generationStartTime: number | null;
}

/** Stats derived from LLMRequestState for dashboard rendering */
export interface LLMStats {
  phase: RequestPhase;
  taskId: number | null;
  promptTokensTotal: number | null;
  promptTokensSeen: number;
  promptSpeed: number;
  promptElapsedMs: number;
  promptComplete: boolean;
  generatedTokensTotal: number;
  generationSpeed: number;
  generationStartTime: number | null;
  generationComplete: boolean;
  finalSummary: SummaryLine | null;
  totalStartTime: number | null;
  totalElapsedMs: number;
}

// ─── Parser ─────────────────────────────────────────────────

const PROMPT_PROCESSING_RE =
  /\|\s*task\s+(\d+)\s*\|\s*prompt processing,\s*n_tokens\s*=\s*(\d+),\s*progress\s*=\s*(\d+\.\d+),\s*t\s*=\s*([\d.]+)\s*s\s*\/\s*([\d.]+)\s*tokens per second/;

const GENERATION_RE =
  /\|\s*task\s+(\d+)\s*\|\s*n_decoded\s*=\s*(\d+),\s*tg\s*=\s*([\d.]+)\s*t\/s/;

const EMPTY_TIMING_RE = /\|\s*task\s+(\d+)\s*\|(\s*)$/;

const PROMPT_EVAL_SUMMARY_RE =
  /prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*([\d.]+)\s*ms per token,\s*([\d.]+)\s*tokens per second\)/;

const GEN_SUMMARY_RE =
  /\btime\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*([\d.]+)\s*ms per token,\s*([\d.]+)\s*tokens per second\)/;

const TOTAL_SUMMARY_RE = /total time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/;

const RELEASE_RE =
  /slot\s+release:\s*id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*stop processing:\s*n_tokens\s*=\s*(\d+),\s*truncated\s*=\s*(\d+)/;

const IDLE_RE = /all slots are idle/;

const LAUNCH_RE =
  /slot\s+launch_slot_:\s*id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*processing task/;

function extractServiceTimeMs(line: string): number {
  const m = line.match(/\b(\d+)\.(\d{2})\.(\d{3})\.(\d{3})\b/);
  if (m) {
    return (parseInt(m[1], 10) + parseInt(m[2], 10) / 1000) * 1000;
  }
  const iso = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  if (iso) return Date.parse(iso[0]);
  return 0;
}

function extractCoreLine(line: string): string {
  // Try stripping systemd/journalctl wrapper first (e.g. 'llm-router[1234]: ...')
  const coreStart = line.indexOf("]: ");
  if (coreStart !== -1) {
    return line.slice(coreStart + 3).trim();
  }
  // Nothing to strip — use the line as-is (bare service output)
  return line.trim();
}

function extractTaskIdFromCore(core: string): number | null {
  const m = /\|\s*task\s+(\d+)/.exec(core);
  return m ? parseInt(m[1], 10) : null;
}

function extractSlotIdFromCore(core: string): number | null {
  const m = /\|\s*id\s+(\d+)/.exec(core);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Parse a single raw log line into zero or more LogEvent objects.
 */
export function parseLine(rawLine: string): LogEvent[] {
  const core = extractCoreLine(rawLine);
  if (!core) return [];

  const timestampMs = extractServiceTimeMs(core);

  // Prompt processing
  let m = PROMPT_PROCESSING_RE.exec(core);
  if (m) {
    return [
      {
        type: "prompt_processing",
        taskId: parseInt(m[1], 10),
        slotId: extractSlotIdFromCore(core),
        nTokens: parseInt(m[2], 10),
        progress: parseFloat(m[3]),
        elapsedSeconds: parseFloat(m[4]),
        tokensPerSecond: parseFloat(m[5]),
        timestamp: timestampMs,
      },
    ];
  }

  // Generation (n_decoded)
  m = GENERATION_RE.exec(core);
  if (m) {
    return [
      {
        type: "generation",
        taskId: parseInt(m[1], 10),
        slotId: extractSlotIdFromCore(core),
        nDecoded: parseInt(m[2], 10),
        tokensPerSecond: parseFloat(m[3]),
        timestamp: timestampMs,
      },
    ];
  }

  // Empty print_timing (end-of-turn marker)
  if (EMPTY_TIMING_RE.test(core)) {
    return [
      {
        type: "generation",
        taskId: extractTaskIdFromCore(core),
        slotId: extractSlotIdFromCore(core),
        nDecoded: 0,
        tokensPerSecond: 0,
        timestamp: timestampMs,
      },
    ];
  }

  // Prompt eval summary (must be before gen summary — it's longer)
  m = PROMPT_EVAL_SUMMARY_RE.exec(core);
  if (m) {
    return [
      {
        type: "prompt_eval_summary",
        taskId: extractTaskIdFromCore(rawLine),
        slotId: extractSlotIdFromCore(rawLine),
        promptEvalTimeMs: parseFloat(m[1]),
        promptEvalTokens: parseInt(m[2], 10),
        promptEvalMsPerToken: parseFloat(m[3]),
        promptEvalTps: parseFloat(m[4]),
        generationTimeMs: 0,
        generationTokens: 0,
        generationMsPerToken: 0,
        generationTps: 0,
        totalTimeMs: 0,
        totalTokens: 0,
      },
    ];
  }

  // Generation summary
  m = GEN_SUMMARY_RE.exec(core);
  if (m) {
    return [
      {
        type: "generation_summary",
        taskId: extractTaskIdFromCore(rawLine),
        slotId: extractSlotIdFromCore(rawLine),
        promptEvalTimeMs: 0,
        promptEvalTokens: 0,
        promptEvalMsPerToken: 0,
        promptEvalTps: 0,
        generationTimeMs: parseFloat(m[1]),
        generationTokens: parseInt(m[2], 10),
        generationMsPerToken: parseFloat(m[3]),
        generationTps: parseFloat(m[4]),
        totalTimeMs: 0,
        totalTokens: 0,
      },
    ];
  }

  // Total summary
  m = TOTAL_SUMMARY_RE.exec(core);
  if (m) {
    return [
      {
        type: "total_summary",
        taskId: extractTaskIdFromCore(rawLine),
        slotId: extractSlotIdFromCore(rawLine),
        promptEvalTimeMs: 0,
        promptEvalTokens: 0,
        promptEvalMsPerToken: 0,
        promptEvalTps: 0,
        generationTimeMs: 0,
        generationTokens: 0,
        generationMsPerToken: 0,
        generationTps: 0,
        totalTimeMs: parseFloat(m[1]),
        totalTokens: parseInt(m[2], 10),
      },
    ];
  }

  // Release
  m = RELEASE_RE.exec(core);
  if (m) {
    return [
      {
        type: "release",
        taskId: parseInt(m[2], 10),
        slotId: parseInt(m[1], 10),
        nTokens: parseInt(m[3], 10),
        truncated: m[4] !== "0",
      },
    ];
  }

  // Launch slot — earliest sign a request is running
  m = LAUNCH_RE.exec(core);
  if (m) {
    return [
      {
        type: "launch",
        taskId: parseInt(m[2], 10),
        slotId: parseInt(m[1], 10),
      },
    ];
  }

  // Idle
  if (IDLE_RE.test(core)) {
    return [{ type: "idle", timestamp: timestampMs }];
  }

  return [];
}

/** Parse a batch of raw log lines, returning all events in order */
export function parseBatch(rawLines: string[]): LogEvent[] {
  const events: LogEvent[] = [];
  for (const line of rawLines) {
    if (!line.trim()) continue;
    events.push(...parseLine(line));
  }
  return events;
}

// ─── State Machine ──────────────────────────────────────────

function createEmptyState(): LLMRequestState {
  return {
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

/**
 * Process a batch of log events through the state machine.
 * Returns the final LLMRequestState.
 *
 * @param nowMs  Wall-clock time (Date.now()) for elapsed-time tracking.
 *               Pass this from the extension so we don't mix server
 *               uptime clocks with wall-clock time.
 */
export function processEvents(
  initial: LLMRequestState,
  events: LogEvent[],
  nowMs: number = Date.now(),
): LLMRequestState {
  let state = { ...initial };

  for (const event of events) {
    switch (event.type) {
      case "launch":
        state = applyLaunch(state, event, nowMs);
        break;

      case "prompt_processing":
        state = applyPromptProcessing(state, event, nowMs);
        break;

      case "generation":
        state = applyGenerationEvent(state, event, nowMs);
        break;

      case "prompt_eval_summary":
        state = applySummary(state, event, true, nowMs);
        break;

      case "generation_summary":
        state = applySummary(state, event, false, nowMs);
        break;

      case "total_summary":
        if (
          state.phase !== RequestPhase.IDLE &&
          state.phase !== RequestPhase.COMPLETE
        ) {
          state.phase = RequestPhase.GENERATION;
        }
        break;

      case "release":
        if (state.phase === RequestPhase.PROMPT_EVAL) {
          state.phase = RequestPhase.GENERATION;
        }
        state.phase = RequestPhase.COMPLETE;
        break;

      case "idle":
        state = createEmptyState();
        break;
    }
  }

  return state;
}

/**
 * Handle launch_slot_ event — earliest sign a request is running.
 * Transitions from IDLE to PROMPT_EVAL immediately so the UI
 * updates without waiting for the first print_timing line.
 */
function applyLaunch(
  state: LLMRequestState,
  event: LaunchEvent,
  nowMs: number,
): LLMRequestState {
  if (state.phase !== RequestPhase.IDLE) return state;

  state = { ...createEmptyState() };
  state.taskId = event.taskId;
  state.slotId = event.slotId;
  state.phase = RequestPhase.PROMPT_EVAL;
  state.requestStartTime = nowMs; // wall-clock start, no delay!

  return state;
}

function applyPromptProcessing(
  state: LLMRequestState,
  event: PromptProcessingEvent,
  nowMs: number,
): LLMRequestState {
  if (state.phase === RequestPhase.IDLE || state.taskId === null) {
    state = { ...createEmptyState() };
    state.taskId = event.taskId;
    state.slotId = event.slotId ?? state.slotId;
    state.phase = RequestPhase.PROMPT_EVAL;
    state.requestStartTime = nowMs; // wall-clock start (fallback if launch missed)
  }

  // If launch already set requestStartTime, keep it (it's earlier)
  if (!state.requestStartTime) {
    state.requestStartTime = nowMs;
  }

  if (state.phase !== RequestPhase.PROMPT_EVAL) return state;

  state.promptTokensSeen = event.nTokens;
  state.promptSpeed = event.tokensPerSecond;

  if (event.progress >= 1.0) {
    state.promptTokensTotal = event.nTokens;
  } else if (state.promptTokensTotal === null) {
    const estimatedTotal = Math.round(event.nTokens / event.progress);
    state.promptTokensTotal = estimatedTotal;
  }

  return state;
}

function applyGenerationEvent(
  state: LLMRequestState,
  event: GenerationEvent,
  nowMs: number,
): LLMRequestState {
  // Empty print_timing signals transition from prompt → generation
  if (event.nDecoded === 0 && state.phase === RequestPhase.PROMPT_EVAL) {
    state.phase = RequestPhase.GENERATION;
    state.generationStartTime = nowMs; // wall-clock start
    return state;
  }

  // Transition from prompt_eval → generation on any n_decoded > 0 line
  if (state.phase === RequestPhase.PROMPT_EVAL) {
    state.phase = RequestPhase.GENERATION;
    if (!state.generationStartTime) {
      state.generationStartTime = nowMs;
    }
  }

  // Start new request if IDLE
  if (state.phase === RequestPhase.IDLE) {
    state = { ...createEmptyState() };
    state.taskId = event.taskId;
    state.slotId = event.slotId ?? state.slotId;
    state.phase = RequestPhase.GENERATION;
    state.requestStartTime = nowMs;
  }

  // Now we should be in GENERATION phase or just transitioned to it
  if (state.phase !== RequestPhase.GENERATION) return state;

  state.generatedTokensTotal = event.nDecoded;
  state.generationSpeed = event.tokensPerSecond;

  if (!state.generationStartTime) {
    state.generationStartTime = nowMs;
  }

  return state;
}

function applySummary(
  state: LLMRequestState,
  event: SummaryLine,
  isPrompt: boolean,
  nowMs: number,
): LLMRequestState {
  if (isPrompt) {
    // Always use actual summary values — these are definitive measurements
    state.promptTokensTotal = event.promptEvalTokens;
    state.promptElapsedMs = event.promptEvalTimeMs;
    state.promptSpeed = event.promptEvalTps;
    // Transition to generation when we see the first prompt summary
    if (
      state.phase !== RequestPhase.GENERATION &&
      state.phase !== RequestPhase.COMPLETE
    ) {
      state.phase = RequestPhase.GENERATION;
    }
  } else {
    // Generation summary — already in generation or completing
    if (!state.generationStartTime && state.phase !== RequestPhase.COMPLETE) {
      state.generationStartTime = nowMs;
    }
  }

  return state;
}

// ─── Dashboard Renderer (pure functions, theme-agnostic) ────

/** Format tokens count with comma separator */
export function formatTokens(n: number): string {
  return n.toLocaleString();
}

/** Format speed (tokens/second) to one decimal */
export function formatSpeed(tps: number): string {
  if (tps <= 0 || !isFinite(tps)) return "—";
  return `${tps.toFixed(1)}`;
}

/** Format milliseconds as a human-readable duration */
export function formatMs(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Build a progress bar of the given width */
export function progressBar(pct: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Derive LLMStats from the raw state machine output */
export function deriveStats(
  state: LLMRequestState,
  now: number = Date.now(),
): LLMStats {
  // Use wall-clock requestStartTime tracked by the state machine
  const totalStart =
    state.phase === RequestPhase.IDLE ? null : state.requestStartTime;

  return {
    phase: state.phase,
    taskId: state.taskId,
    promptTokensTotal: state.promptTokensTotal,
    promptTokensSeen: state.promptTokensSeen,
    promptSpeed: state.promptSpeed,
    promptElapsedMs: state.promptElapsedMs,
    promptComplete: state.phase !== RequestPhase.PROMPT_EVAL,
    generatedTokensTotal: state.generatedTokensTotal,
    generationSpeed: state.generationSpeed,
    generationStartTime: state.generationStartTime,
    generationComplete: state.phase === RequestPhase.COMPLETE,
    finalSummary: null,
    totalStartTime: totalStart,
    totalElapsedMs: totalStart ? now - totalStart : 0,
  };
}

/**
 * Render the full dashboard widget as an array of plain strings.
 * Colors are applied by the caller using `theme.fg()`.
 */
export function renderDashboard(
  stats: LLMStats,
  theme?: { fg: (color: string, text: string) => string },
): string[] {
  const t = theme?.fg ?? ((_, text) => text);

  const lines: string[] = [];

  // Status bar
  let statusColor = "dim";
  let statusLabel = "Idle — no active request";
  switch (stats.phase) {
    case RequestPhase.IDLE:
      break;
    case RequestPhase.PROMPT_EVAL:
      statusColor = "warning";
      statusLabel = "Prompt evaluation in progress";
      break;
    case RequestPhase.GENERATION:
      statusColor = "accent";
      statusLabel = "Token generation in progress";
      break;
    case RequestPhase.COMPLETE:
      statusColor = "success";
      statusLabel = "Request complete";
      break;
  }
  lines.push(t(statusColor, ` ● ${statusLabel} `));

  if (stats.phase === RequestPhase.IDLE) return lines;

  // ── Prompt eval section ────────────────────────────────────
  lines.push("");

  if (stats.promptTokensTotal && stats.promptTokensTotal > 0) {
    const total = stats.promptTokensTotal;
    const seen = Math.min(stats.promptTokensSeen, total);

    if (stats.phase === RequestPhase.PROMPT_EVAL) {
      const pct = Math.round((seen / total) * 100);
      lines.push(`${t("muted", "Prompt:")} ${progressBar(pct, 20)} ${pct}%`);
    } else {
      lines.push(`${t("muted", "Prompt:")} ✓ Done`);
    }

    lines.push(
      `${" ".repeat(4)}${formatTokens(seen)} / ${formatTokens(total)} tokens`,
    );

    if (stats.promptSpeed > 0) {
      lines.push(
        `${" ".repeat(4)}Speed: ${t("success", `${formatSpeed(stats.promptSpeed)} tok/s`)}`,
      );
    }
  } else if (stats.promptTokensSeen > 0) {
    lines.push(
      `${t("muted", "Prompt:")} ${formatTokens(stats.promptTokensSeen)} tokens so far`,
    );
    if (stats.promptSpeed > 0) {
      lines.push(
        `${" ".repeat(4)}Speed: ${t("success", `${formatSpeed(stats.promptSpeed)} tok/s`)}`,
      );
    }
    if (stats.promptElapsedMs > 0) {
      lines.push(`${" ".repeat(4)}Elapsed: ${formatMs(stats.promptElapsedMs)}`);
    }
  }

  // ── Generation section ─────────────────────────────────────
  lines.push("");

  if (stats.phase === RequestPhase.GENERATION || stats.generationComplete) {
    if (stats.generatedTokensTotal > 0) {
      lines.push(
        `${t("muted", "Generation:")} ${formatTokens(stats.generatedTokensTotal)} tokens`,
      );

      if (stats.generationSpeed > 0) {
        lines.push(
          `${" ".repeat(4)}Speed: ${t("success", `${formatSpeed(stats.generationSpeed)} tok/s`)}`,
        );
      }

      if (
        stats.generationStartTime &&
        stats.phase === RequestPhase.GENERATION
      ) {
        const elapsed = Date.now() - stats.generationStartTime;
        lines.push(`${" ".repeat(4)}Elapsed: ${formatMs(elapsed)}`);
      }
    } else if (stats.phase === RequestPhase.GENERATION) {
      lines.push(t("dim", "Generation: waiting for tokens..."));
    }
  }

  // ── Footer ─────────────────────────────────────────────────
  if (stats.totalStartTime && stats.phase !== RequestPhase.IDLE) {
    const elapsed = Date.now() - stats.totalStartTime;
    lines.push("");
    lines.push(t("dim", ` Total: ${formatMs(elapsed)}`));
  }

  return lines;
}

/**
 * Render a single-line compact status for the footer.
 */
export function renderFooterStatus(
  stats: LLMStats,
  theme?: { fg: (color: string, text: string) => string },
): string {
  const t = theme?.fg ?? ((_, text) => text);

  if (stats.phase === RequestPhase.IDLE) {
    return t("dim", "○ llm-monitor idle");
  }

  let parts: string[] = [];

  switch (stats.phase) {
    case RequestPhase.PROMPT_EVAL: {
      const pct =
        stats.promptTokensTotal && stats.promptTokensTotal > 0
          ? Math.round((stats.promptTokensSeen / stats.promptTokensTotal) * 100)
          : null;
      if (pct !== null) {
        parts.push(t("warning", "⚙ Prompt Eval"));
        parts.push(`${formatTokens(stats.promptTokensSeen)} tok`);
        parts.push(`${formatSpeed(stats.promptSpeed)} t/s`);
        parts.push(`${pct}%`);
      } else {
        parts.push(t("warning", "⚙ Prompt Eval"));
        parts.push(
          `${stats.promptTokensSeen} tok · ${formatSpeed(stats.promptSpeed)} t/s`,
        );
      }
      break;
    }

    case RequestPhase.GENERATION:
      if (stats.generatedTokensTotal > 0) {
        parts.push(t("accent", "◉ Gen"));
        parts.push(`${formatTokens(stats.generatedTokensTotal)} tok`);
        parts.push(`${formatSpeed(stats.generationSpeed)} t/s`);
      } else {
        parts.push(t("accent", "◉ Gen"));
        parts.push("waiting tokens...");
      }
      break;

    case RequestPhase.COMPLETE:
      parts.push(t("success", "✓ Done"));
      if (stats.promptSpeed > 0) {
        parts.push(`${formatTokens(stats.promptTokensSeen)} prompt tok`);
      }
      if (stats.generatedTokensTotal > 0) {
        parts.push(
          `${formatTokens(stats.generatedTokensTotal)} gen tok · ${formatSpeed(stats.generationSpeed)} t/s`,
        );
      }
      break;
  }

  return parts.join(" · ");
}

/**
 * Create an idle LLMStats object for dashboard rendering.
 * Used by the extension to initialize/reset the display.
 */
export function createIdleStats(): LLMStats {
  return {
    phase: RequestPhase.IDLE,
    taskId: null,
    promptTokensTotal: null,
    promptTokensSeen: 0,
    promptSpeed: 0,
    promptElapsedMs: 0,
    promptComplete: false,
    generatedTokensTotal: 0,
    generationSpeed: 0,
    generationStartTime: null,
    generationComplete: false,
    finalSummary: null,
    totalStartTime: null,
    totalElapsedMs: 0,
  };
}

/**
 * Parse the full test log fixture and run through state machine.
 * Exported for use in tests — replays raw log lines through the parser
 * and state machine, then derives final stats.
 */
export function processLogFixture(lines: string[]): LLMStats {
  let state = createEmptyState();
  for (const line of lines) {
    if (!line.trim()) continue;
    const events = parseLine(line);
    if (events.length > 0) {
      state = processEvents(state, events);
    }
  }
  return deriveStats(state);
}
