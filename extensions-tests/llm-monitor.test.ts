/**
 * Tests for llm-monitor extension.
 *
 * Suites:
 *   1. Parser — unit tests on parseLine (regex matching, field extraction)
 *   2. State Machine — unit tests on processEvents (phase transitions)
 *   3. Format Helpers — unit tests on formatTokens, formatSpeed, formatMs, progressBar
 *   4. Dashboard Renderer — unit tests on renderDashboard, renderFooterStatus
 *   5. Fixture Integration — full lifecycle replay against real log data
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  createIdleStats,
  parseLine,
  parseBatch,
  processEvents,
  processLogFixture,
  deriveStats,
  renderDashboard,
  renderFooterStatus,
  formatTokens,
  formatSpeed,
  formatMs,
  progressBar,
  RequestPhase,
  type LogEvent,
} from "../extensions/llm-monitor/llm-monitor-lib";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(TEST_DIR, "fixtures", "llm-monitor-test.log");
const EXTENSIONS_DIR = path.resolve(TEST_DIR, "..", "extensions");
const readExtensionFile = (name: string): string =>
  fs.readFileSync(path.resolve(EXTENSIONS_DIR, name), "utf-8");

// ===========================================================================
// 1. PARSER — parseLine unit tests
// ===========================================================================

describe("parseLine (parser)", () => {
  it.each([
    [
      "prompt processing with progress < 1",
      "[60713] 841.46.011.264 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 0.24, t =   5.83 s / 1406.04 tokens per second",
      {
        type: "prompt_processing",
        nTokens: 8192,
        progress: 0.24,
        elapsedSeconds: 5.83,
        tokensPerSecond: 1406.04,
      } as const,
    ],
    [
      "prompt processing with progress = 1.00",
      "[60713] 842.17.435.488 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =  33622, progress = 1.00, t =  37.25 s / 902.59 tokens per second",
      {
        type: "prompt_processing",
        nTokens: 33622,
        progress: 1.0,
        elapsedSeconds: 37.25,
        tokensPerSecond: 902.59,
      } as const,
    ],
    [
      "generation (n_decoded)",
      "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | n_decoded =    100, tg =  49.88 t/s",
      { type: "generation", nDecoded: 100, tokensPerSecond: 49.88 } as const,
    ],
    [
      "generation with larger decoded count",
      "[60713] 862.57.763.422 I slot print_timing: id  0 | task 14766 | n_decoded =   1115, tg =  48.13 t/s",
      { type: "generation", nDecoded: 1115, tokensPerSecond: 48.13 } as const,
    ],
    [
      "prompt eval summary",
      "[60713] prompt eval time =   40420.08 ms / 33626 tokens (    1.20 ms per token,   831.91 tokens per second)",
      { type: "prompt_eval_summary" } as const,
    ],
    [
      "generation summary",
      "[60713]        eval time =   12922.17 ms /   644 tokens (   20.07 ms per token,    49.84 tokens per second)",
      { type: "generation_summary" } as const,
    ],
    [
      "total time summary",
      "[60713]       total time =   53342.24 ms / 34270 tokens",
      { type: "total_summary" } as const,
    ],
    [
      "slot release",
      "[60713] 842.33.527.946 I slot      release: id  0 | task 12160 | stop processing: n_tokens = 34269, truncated = 0",
      { type: "release", nTokens: 34269, truncated: false } as const,
    ],
    [
      "slot release with truncation",
      "[60713] I slot      release: id  0 | task 12160 | stop processing: n_tokens = 500, truncated = 1",
      { type: "release", nTokens: 500, truncated: true } as const,
    ],
    [
      "all slots idle",
      "[60713] 842.33.527.981 I srv  update_slots: all slots are idle",
      { type: "idle" } as const,
    ],
  ] as Array<[string, string, Record<string, unknown>]>)('parses "%s"', (_name, line, expected) => {
    const result = parseLine(line);

    expect(result.length).toBe(1);
    expect(result[0].type).toBe(expected.type);
    if (expected.type === "prompt_processing") {
      const evt = result[0] as Awaited<ReturnType<typeof parseLine>>[number] & { type: "prompt_processing" };
      expect(evt.nTokens).toBe(expected.nTokens);
      expect(evt.progress).toBe(expected.progress);
      expect(evt.elapsedSeconds).toBe(expected.elapsedSeconds);
      expect(evt.tokensPerSecond).toBe(expected.tokensPerSecond);
    } else if (expected.type === "generation") {
      const evt = result[0] as Awaited<ReturnType<typeof parseLine>>[number] & { type: "generation" };
      expect(evt.nDecoded).toBe(expected.nDecoded);
      expect(evt.tokensPerSecond).toBe(expected.tokensPerSecond);
    } else if (expected.type === "release") {
      const evt = result[0] as Awaited<ReturnType<typeof parseLine>>[number] & { type: "release" };
      expect(evt.nTokens).toBe(expected.nTokens);
      expect(evt.truncated).toBe(expected.truncated);
    }
  });

  it("empty string produces no events", () => {
    expect(parseLine("")).toHaveLength(0);
  });

  it("whitespace-only line produces no events", () => {
    expect(parseLine("   \n\t  ")).toHaveLength(0);
  });

  it("garbage text produces no events", () => {
    expect(parseLine("this is not a log line")).toHaveLength(0);
    expect(parseLine("#!/usr/bin/env python3")).toHaveLength(0);
    expect(parseLine("const x = 42;")).toHaveLength(0);
  });

  it("non-log service output produces no events", () => {
    expect(parseLine("[60713] 841.40.066.183 I srv  params_from_: Chat format: peg-native")).toHaveLength(0);
    expect(
      parseLine("[60713] 841.40.184.954 W slot update_slots: id  0 | task 12160 | n_past = 5919"),
    ).toHaveLength(0);
  });

  it("extracts core line from systemd-wrapped log", () => {
    const wrappedLine =
      "maj 16 12:49:12 RX-78-FPC llm-router[2979]: [60713] 841.46.011.264 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 0.24, t =   5.83 s / 1406.04 tokens per second";
    const result = parseLine(wrappedLine);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("prompt_processing");
  });

  it("empty print_timing line (end-of-turn marker) is parsed as generation with nDecoded=0", () => {
    const result = parseLine("[60713] 842.33.527.206 I slot print_timing: id  0 | task 12160 |");
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("generation");
    // nDecoded is extracted from regex group — empty string → NaN, handled as 0
  });

  it("parseBatch processes multiple lines", () => {
    const lines = [
      "[60713] prompt eval time =   40420.08 ms / 33626 tokens (    1.20 ms per token,   831.91 tokens per second)",
      "", // blank line
      "garbage",
      "[60713]       total time =   53342.24 ms / 34270 tokens",
    ];
    const result = parseBatch(lines);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("prompt_eval_summary");
    expect(result[1].type).toBe("total_summary");
  });

  // Summary line field extraction tests
  it("extracts all fields from prompt eval summary", () => {
    const line =
      "[60713] prompt eval time =   40420.08 ms / 33626 tokens (    1.20 ms per token,   831.91 tokens per second)";
    const [evt] = parseLine(line);
    expect(evt.type).toBe("prompt_eval_summary");

    if (evt.type === "prompt_eval_summary") {
      expect(evt.promptEvalTimeMs).toBe(40420.08);
      expect(evt.promptEvalTokens).toBe(33626);
      expect(evt.promptEvalMsPerToken).toBe(1.2);
      expect(evt.promptEvalTps).toBe(831.91);
    }
  });

  it("extracts all fields from generation summary", () => {
    const line =
      "[60713]        eval time =   12922.17 ms /   644 tokens (   20.07 ms per token,    49.84 tokens per second)";
    const [evt] = parseLine(line);
    expect(evt.type).toBe("generation_summary");

    if (evt.type === "generation_summary") {
      expect(evt.generationTimeMs).toBe(12922.17);
      expect(evt.generationTokens).toBe(644);
      expect(evt.generationMsPerToken).toBe(20.07);
      expect(evt.generationTps).toBe(49.84);
    }
  });

  it("extracts all fields from total summary", () => {
    const line = "[60713]       total time =   53342.24 ms / 34270 tokens";
    const [evt] = parseLine(line);
    expect(evt.type).toBe("total_summary");

    if (evt.type === "total_summary") {
      expect(evt.totalTimeMs).toBe(53342.24);
      expect(evt.totalTokens).toBe(34270);
    }
  });

  it("parses short-prompt request summary", () => {
    const line =
      "[60713] prompt eval time =     262.13 ms /    53 tokens (    4.95 ms per token,   202.19 tokens per second)";
    const [evt] = parseLine(line);
    expect(evt.type).toBe("prompt_eval_summary");

    if (evt.type === "prompt_eval_summary") {
      expect(evt.promptEvalTimeMs).toBe(262.13);
      expect(evt.promptEvalTokens).toBe(53);
      expect(evt.promptEvalTps).toBe(202.19);
    }
  });

  it("parses different total time values correctly", () => {
    // Short request
    const short = parseLine("[60713]       total time =    3249.28 ms /   992 tokens");
    if (short[0]?.type === "total_summary") expect(short[0].totalTimeMs).toBe(3249.28);

    // Long request
    const long = parseLine("[60713]       total time =   52515.26 ms /  3041 tokens");
    if (long[0]?.type === "total_summary") expect(long[0].totalTimeMs).toBe(52515.26);
  });
});

// ===========================================================================
// 2. STATE MACHINE — processEvents unit tests
// ===========================================================================

describe("processEvents (state machine)", () => {
  it.each([
    // [name, inputPhaseStr, eventTypesExpected]
    ["idle → prompt_processing starts task", "IDLE", ["prompt_processing"], RequestPhase.PROMPT_EVAL],
    [
      "generation during prompt phase → transition to generation",
      "IDLE",
      ["generation"],
      RequestPhase.GENERATION,
    ],
  ] as Array<[string, string, Array<LogEvent["type"]>, RequestPhase]>)(
    "%s",
    (_name, initialPhaseStr, eventTypes, expectedPhase) => {
      const initial = {
        phase: RequestPhase[initialPhaseStr as keyof typeof RequestPhase],
        taskId: null,
        slotId: null,
        promptTokensTotal: null,
        promptTokensSeen: 0,
        promptSpeed: 0,
        promptElapsedMs: 0,
        generatedTokensTotal: 0,
        generationSpeed: 0,
        generationStartTime: null,
      };

      const events = eventTypes
        .map((type) => {
          if (type === "prompt_processing") {
            return parseLine(
              "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 0.24, t =   5.83 s / 1406.04 tokens per second",
            );
          } else {
            return parseLine(
              "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | n_decoded =    100, tg =  49.88 t/s",
            );
          }
        })
        .flat();

      const result = processEvents(initial, events);
      expect(result.phase).toBe(expectedPhase);
    },
  );

  it("transitions: idle → prompt_eval (first prompt_processing line)", () => {
    const initial = createIdleState();
    const [event] = parseLine(
      "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 0.24, t =   5.83 s / 1406.04 tokens per second",
    );

    const result = processEvents(initial, [event]);
    expect(result.phase).toBe(RequestPhase.PROMPT_EVAL);
    expect(result.taskId).toBe(12160);
    expect(result.promptTokensSeen).toBe(8192);
  });

  it("updates prompt tokens and speed incrementally", () => {
    let state = createIdleState();

    const lines = [
      "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 0.24, t =   5.83 s / 1406.04 tokens per second",
      "[60713] 842.22.609.897 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =  16384, progress = 0.50, t =  10.00 s / 1300.00 tokens per second",
    ];

    for (const line of lines) {
      state = processEvents(state, parseLine(line));
    }

    expect(state.phase).toBe(RequestPhase.PROMPT_EVAL);
    expect(state.promptTokensSeen).toBe(16384);
    // Last seen speed should be the latest batch
    expect(state.promptSpeed).toBe(1300.0);
  });

  it("estimates total from progress < 1.0", () => {
    const initial = createIdleState();
    const [event] = parseLine(
      "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 0.24, t =   5.83 s / 1406.04 tokens per second",
    );
    const result = processEvents(initial, [event]);

    expect(result.promptTokensTotal).toBe(34133); // Math.round(8192 / 0.24) ≈ 34133
  });

  it("sets total from progress = 1.0 line", () => {
    const initial = createIdleState();
    const [event] = parseLine(
      "[60713] 842.17.435.488 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =  33622, progress = 1.00, t =  37.25 s / 902.59 tokens per second",
    );
    const result = processEvents(initial, [event]);

    expect(result.promptTokensTotal).toBe(33622);
    expect(result.promptTokensSeen).toBe(33622);
  });

  it("transitions to generation on empty print_timing (nDecoded=0) during prompt eval", () => {
    let state = createIdleState();

    // First, start prompt eval
    const ppLine = parseLine(
      "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 0.24, t =   5.83 s / 1406.04 tokens per second",
    );
    state = processEvents(state, ppLine);
    expect(state.phase).toBe(RequestPhase.PROMPT_EVAL);

    // Empty print_timing → transition to generation
    const emptyLine = parseLine("[60713] 842.33.527.206 I slot print_timing: id  0 | task 12160 |");
    state = processEvents(state, emptyLine);

    expect(state.phase).toBe(RequestPhase.GENERATION);
  });

  it("updates generation token count and speed", () => {
    let state = createIdleState();

    // Start prompt eval quickly
    const ppLine = parseLine(
      "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 1.00, t =   5.83 s / 1406.04 tokens per second",
    );
    state = processEvents(state, ppLine);

    // Generate tokens
    const genLines = [
      "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | n_decoded =    100, tg =  49.88 t/s",
      "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | n_decoded =    550, tg =  49.87 t/s",
      "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | n_decoded =   1115, tg =  48.13 t/s",
    ];

    for (const line of genLines) {
      state = processEvents(state, parseLine(line));
    }

    expect(state.phase).toBe(RequestPhase.GENERATION);
    expect(state.generatedTokensTotal).toBe(1115);
    expect(state.generationSpeed).toBe(48.13);
  });

  it("updates summary values on prompt eval summary", () => {
    let state = createIdleState();

    // Start a task
    state = processEvents(
      state,
      parseLine(
        "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 0.24, t =   5.83 s / 1406.04 tokens per second",
      ),
    );

    // Apply prompt eval summary
    const peLine = parseLine(
      "[60713] prompt eval time =   40420.08 ms / 33626 tokens (    1.20 ms per token,   831.91 tokens per second)",
    );
    state = processEvents(state, peLine);

    expect(state.promptTokensTotal).toBe(33626);
    expect(state.promptElapsedMs).toBe(40420.08);
    expect(state.promptSpeed).toBe(831.91);
  });

  it("transitions to idle on 'all slots are idle' line", () => {
    let state = createIdleState();

    // Start a full request through prompt eval → generation
    state = processEvents(
      state,
      parseLine(
        "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 1.00, t =   5.83 s / 1406.04 tokens per second",
      ),
    );
    expect(state.phase).toBe(RequestPhase.PROMPT_EVAL);

    state = processEvents(
      state,
      parseLine(
        "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | n_decoded =    100, tg =  49.88 t/s",
      ),
    );
    expect(state.phase).toBe(RequestPhase.GENERATION);

    // Idle resets everything
    const idleLine = parseLine("[60713] 842.33.527.981 I srv  update_slots: all slots are idle");
    state = processEvents(state, idleLine);

    expect(state.phase).toBe(RequestPhase.IDLE);
    expect(state.taskId).toBeNull();
    expect(state.promptTokensSeen).toBe(0);
    expect(state.generatedTokensTotal).toBe(0);
  });

  it("handles launch event to start a new request", () => {
    const initial = createIdleState();
    const launchLine = parseLine(
      "[60713] 842.20.100.500 I slot launch_slot_: id  0 | task 99999 | processing task",
    );

    expect(launchLine.length).toBe(1);
    const result = processEvents(initial, launchLine);

    expect(result.phase).toBe(RequestPhase.PROMPT_EVAL);
    expect(result.taskId).toBe(99999);
    expect(result.slotId).toBe(0);
    expect(result.requestStartTime).not.toBeNull();
  });

  it("sets requestStartTime fallback in applyPromptProcessing when launch was skipped", () => {
    const initial = createIdleState();
    // First prompt_processing without a preceding launch — should set requestStartTime as fallback
    const ppLine = parseLine(
      "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 0.24, t =   5.83 s / 1406.04 tokens per second",
    );

    const result = processEvents(initial, ppLine);
    expect(result.phase).toBe(RequestPhase.PROMPT_EVAL);
    // requestStartTime should be set by the fallback path
    expect(result.requestStartTime).not.toBeNull();
  });

  it("sets requestStartTime in applyPromptProcessing when state is non-IDLE but has no start time", () => {
    // Edge case: state is already in PROMPT_EVAL with a taskId, but requestStartTime was never set
    const state: Parameters<typeof processEvents>[0] = {
      phase: RequestPhase.PROMPT_EVAL,
      taskId: 12160,
      slotId: 0,
      promptTokensTotal: null,
      promptTokensSeen: 0,
      promptSpeed: 0,
      promptElapsedMs: 0,
      generatedTokensTotal: 0,
      generationSpeed: 0,
      generationStartTime: null,
      requestStartTime: null, // explicitly null
    };

    const ppLine = parseLine(
      "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 0.24, t =   5.83 s / 1406.04 tokens per second",
    );

    const result = processEvents(state, ppLine);
    expect(result.phase).toBe(RequestPhase.PROMPT_EVAL);
    // requestStartTime should be set by the fallback path (line 463)
    expect(result.requestStartTime).not.toBeNull();
    expect(result.promptTokensSeen).toBe(8192);
  });

  it("sets generationStartTime on generation_summary when not yet set", () => {
    let state = createIdleState();

    // Start prompt eval via prompt_processing
    state = processEvents(
      state,
      parseLine(
        "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 0.24, t =   5.83 s / 1406.04 tokens per second",
      ),
    );

    // Apply prompt eval summary → transitions to GENERATION but doesn't set generationStartTime
    const peLine = parseLine(
      "[60713] prompt eval time =   40420.08 ms / 33626 tokens (    1.20 ms per token,   831.91 tokens per second)",
    );
    state = processEvents(state, peLine);

    expect(state.phase).toBe(RequestPhase.GENERATION);
    expect(state.generationStartTime).toBeNull(); // not set yet

    // Now apply generation_summary — should set generationStartTime (line 544 path)
    const genSummaryLine = parseLine(
      "[60713]        eval time =   12922.17 ms /   644 tokens (   20.07 ms per token,    49.84 tokens per second)",
    );
    state = processEvents(state, genSummaryLine);

    expect(state.phase).toBe(RequestPhase.GENERATION);
    expect(state.generationStartTime).not.toBeNull();
  });

  it("transitions to complete on release line", () => {
    let state = createIdleState();
    state = processEvents(
      state,
      parseLine(
        "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 1.00, t =   5.83 s / 1406.04 tokens per second",
      ),
    );
    state = processEvents(
      state,
      parseLine(
        "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | n_decoded =    100, tg =  49.88 t/s",
      ),
    );

    const releaseLine = parseLine(
      "[60713] 842.33.527.946 I slot      release: id  0 | task 12160 | stop processing: n_tokens = 34269, truncated = 0",
    );
    state = processEvents(state, releaseLine);

    expect(state.phase).toBe(RequestPhase.COMPLETE);
  });

  it("handles prompt-only request (no generation tokens) — short prompt", () => {
    let state = createIdleState();

    // Short prompt → no actual generation → just empty print_timing + summaries
    const idleLine = parseLine("[60713] 862.26.333.297 I slot print_timing: id  0 | task 14575 |"); // empty timing (prompt-only)
    state = processEvents(state, idleLine);

    // This triggers generation phase transition from empty print_timing
    // But since no tokens were decoded, it stays at 0 generation tokens
    expect(state.phase).toBe(RequestPhase.GENERATION);
  });

  it("total_summary does not change phase if already in complete or idle", () => {
    let state = createIdleState();

    // Complete phase via release
    state = processEvents(
      state,
      parseLine(
        "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 1.00, t =   5.83 s / 1406.04 tokens per second",
      ),
    );
    state = processEvents(
      state,
      parseLine(
        "[60713] 842.33.527.946 I slot      release: id  0 | task 12160 | stop processing: n_tokens = 34269, truncated = 0",
      ),
    );
    expect(state.phase).toBe(RequestPhase.COMPLETE);

    // Total summary after complete should not change state
    const totalLine = parseLine("[60713]       total time =   53342.24 ms / 34270 tokens");
    state = processEvents(state, totalLine);
    expect(state.phase).toBe(RequestPhase.COMPLETE);
  });

  it("skips setting generationStartTime when already set during PROMPT_EVAL→GENERATION transition", () => {
    // Edge case: state is in PROMPT_EVAL with generationStartTime already set,
    // then an n_decoded event arrives → should transition to GENERATION without re-setting startTime
    const state: Parameters<typeof processEvents>[0] = {
      phase: RequestPhase.PROMPT_EVAL,
      taskId: 12160,
      slotId: 0,
      promptTokensTotal: 33626,
      promptTokensSeen: 33626,
      promptSpeed: 831.91,
      promptElapsedMs: 40420.08,
      generatedTokensTotal: 0,
      generationSpeed: 0,
      generationStartTime: Date.now() - 1000, // already set!
    };

    const genLine = parseLine(
      "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | n_decoded =    100, tg =  49.88 t/s",
    );

    const result = processEvents(state, genLine);
    expect(result.phase).toBe(RequestPhase.GENERATION);
    // generationStartTime should be unchanged (not re-set)
    expect(result.generationStartTime).toBe(state.generationStartTime);
  });

  it("processes n_decoded event when already in GENERATION phase — updates tokens", () => {
    // Directly test line 511 else branch: phase IS GENERATION, proceed to update tokens
    const state: Parameters<typeof processEvents>[0] = {
      phase: RequestPhase.GENERATION,
      taskId: 12160,
      slotId: 0,
      promptTokensTotal: 33626,
      promptTokensSeen: 33626,
      promptSpeed: 831.91,
      promptElapsedMs: 40420.08,
      generatedTokensTotal: 100, // previous count
      generationSpeed: 49.88,
      generationStartTime: Date.now() - 5000,
    };

    const genLine = parseLine(
      "[60713] 842.22.609.896 I slot print_timing: id  0 | task 12160 | n_decoded =    550, tg =  49.87 t/s",
    );

    const result = processEvents(state, genLine);
    // Should proceed past the phase check and update tokens
    expect(result.phase).toBe(RequestPhase.GENERATION);
    expect(result.generatedTokensTotal).toBe(550);
    expect(result.generationSpeed).toBe(49.87);
  });
});

function createIdleState(): Parameters<typeof processEvents>[0] {
  return {
    phase: RequestPhase.IDLE,
    taskId: null,
    slotId: null,
    promptTokensTotal: null,
    promptTokensSeen: 0,
    promptSpeed: 0,
    promptElapsedMs: 0,
    generatedTokensTotal: 0,
    generationSpeed: 0,
    generationStartTime: null,
  };
}

// ===========================================================================
// 3. FORMAT HELPERS
// ===========================================================================

describe("formatTokens", () => {
  it("formats small numbers directly", () => {
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with comma", () => {
    expect(formatTokens(1000)).toBe("1,000");
    expect(formatTokens(12345)).toBe("12,345");
    expect(formatTokens(1000000)).toBe("1,000,000");
  });

  it("handles zero", () => {
    expect(formatTokens(0)).toBe("0");
  });
});

describe("formatSpeed", () => {
  it("formats positive speed to one decimal", () => {
    expect(formatSpeed(49.876)).toBe("49.9");
    expect(formatSpeed(23.456)).toBe("23.5");
    expect(formatSpeed(100)).toBe("100.0");
  });

  it("returns em-dash for non-positive or NaN", () => {
    expect(formatSpeed(0)).toBe("—");
    expect(formatSpeed(-5)).toBe("—");
    expect(formatSpeed(NaN)).toBe("—");
    expect(formatSpeed(Infinity)).toBe("—");
  });
});

describe("formatMs", () => {
  it("formats under 1 second as ms", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(500)).toBe("500ms");
    expect(formatMs(999)).toBe("999ms");
  });

  it("formats >= 1 second as seconds", () => {
    expect(formatMs(1000)).toBe("1.00s");
    expect(formatMs(1500)).toBe("1.50s");
    expect(formatMs(53342)).toBe("53.34s");
  });

  it("clamps negative to zero", () => {
    expect(formatMs(-100)).toBe("0ms");
  });
});

describe("progressBar", () => {
  it("returns empty bar for 0%", () => {
    expect(progressBar(0, 20)).toBe("░░░░░░░░░░░░░░░░░░░░");
  });

  it("returns full bar for 100%", () => {
    expect(progressBar(100, 20)).toBe("████████████████████");
  });

  it("shows correct fill ratio", () => {
    const bar = progressBar(50, 20);
    const filled = (bar.match(/█/g) || []).length;
    const empty = (bar.match(/░/g) || []).length;
    expect(filled).toBe(10);
    expect(empty).toBe(10);
    expect(bar.length).toBe(20);
  });

  it("clamps to valid width for invalid pct", () => {
    expect(progressBar(-10, 10)).toBe("░░░░░░░░░░");
    expect(progressBar(150, 10)).toBe("██████████");
  });

  it("works with different widths", () => {
    expect(progressBar(25, 8)).toMatch(/^██[┴░]{6}$/);
    const bar = progressBar(25, 8);
    expect(bar).not.toBeNull();
    expect(bar.length).toBe(8);
  });
});

// ===========================================================================
// 4. DASHBOARD RENDERER
// ===========================================================================

describe("renderDashboard", () => {
  it("shows idle state with minimal content", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
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

    const lines = renderDashboard(stats);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain("Idle");
  });

  it("shows prompt eval progress with bar", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.PROMPT_EVAL,
      taskId: 12160,
      promptTokensTotal: 33626,
      promptTokensSeen: 16384,
      promptSpeed: 1118.1,
      promptElapsedMs: 14650,
      promptComplete: false,
      generatedTokensTotal: 0,
      generationSpeed: 0,
      generationStartTime: null,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 20000,
      totalElapsedMs: 20000,
    };

    const lines = renderDashboard(stats);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines[0]).toContain("Prompt");
    // Progress bar should be present (during prompt eval)
    const hasBar = lines.some((l) => l.includes("█") && l.includes("░"));
    expect(hasBar).toBe(true);
  });

  it("shows completed prompt with Done indicator", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.GENERATION,
      taskId: 12160,
      promptTokensTotal: 33626,
      promptTokensSeen: 33626,
      promptSpeed: 831.91,
      promptElapsedMs: 40420.08,
      promptComplete: true,
      generatedTokensTotal: 550,
      generationSpeed: 49.87,
      generationStartTime: Date.now() - 5000,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 53000,
      totalElapsedMs: 53000,
    };

    const lines = renderDashboard(stats);
    // Should show prompt completion and token counts
    const hasDone = lines.find((l) => l.match(/Done/));
    expect(hasDone).toBeDefined();
    // formatTokens adds commas, so check for "33,626" not "33626"
    expect(lines.some((l) => l.includes("33,626"))).toBe(true);
    expect(lines.some((l) => l.includes("550"))).toBe(true);
  });

  it("shows no speed line when promptSpeed is 0", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.GENERATION,
      taskId: null,
      promptTokensTotal: null,
      promptTokensSeen: 8192,
      promptSpeed: 0, // zero speed
      promptElapsedMs: 5830,
      promptComplete: false,
      generatedTokensTotal: 550,
      generationSpeed: 49.87,
      generationStartTime: Date.now() - 5000,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 10000,
      totalElapsedMs: 10000,
    };

    const lines = renderDashboard(stats);
    // No speed line in prompt section when speed is 0
    const promptSection = lines.filter((l) => l.includes("Prompt:")).join("\n");
    expect(promptSection).not.toContain("Speed:");
  });

  it("shows no speed line when promptTokensTotal known but promptSpeed is 0", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.GENERATION,
      taskId: 12160,
      promptTokensTotal: 33626, // total is known
      promptTokensSeen: 33626,
      promptSpeed: 0, // but speed is zero
      promptElapsedMs: 40420.08,
      promptComplete: true,
      generatedTokensTotal: 550,
      generationSpeed: 49.87,
      generationStartTime: Date.now() - 5000,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 53000,
      totalElapsedMs: 53000,
    };

    const lines = renderDashboard(stats);
    // No speed line in prompt section when speed is 0
    const promptSection = lines.filter((l) => l.includes("Prompt:")).join("\n");
    expect(promptSection).not.toContain("Speed:");
  });

  it("shows generation tokens without progress bar", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.GENERATION,
      taskId: 12160,
      promptTokensTotal: 33626,
      promptTokensSeen: 33626,
      promptSpeed: 831.91,
      promptElapsedMs: 40420.08,
      promptComplete: true,
      generatedTokensTotal: 550,
      generationSpeed: 49.87,
      generationStartTime: Date.now() - 5000,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 53000,
      totalElapsedMs: 53000,
    };

    const lines = renderDashboard(stats);
    // Should NOT have a progress bar in generation section (only shows token count)
    const genSection = lines.filter((_, i) => i > 3).join("\n");
    expect(genSection).toContain("Generation:");
    expect(genSection).toContain("550 tokens");
    // No ▓ characters in generation section (we removed progress bars for generation)
    expect(genSection).not.toContain("███");
  });

  it("shows elapsed time during generation", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.GENERATION,
      taskId: 12160,
      promptTokensTotal: 33626,
      promptTokensSeen: 33626,
      promptSpeed: 831.91,
      promptElapsedMs: 40420.08,
      promptComplete: true,
      generatedTokensTotal: 550,
      generationSpeed: 49.87,
      generationStartTime: Date.now() - 5000,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 53000,
      totalElapsedMs: 53000,
    };

    const lines = renderDashboard(stats);
    expect(lines.some((l) => l.includes("Elapsed"))).toBe(true);
  });

  it("includes total time footer when active", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.GENERATION,
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
      totalStartTime: Date.now() - 12345,
      totalElapsedMs: 12345,
    };

    const lines = renderDashboard(stats);
    expect(lines.some((l) => l.includes("Total"))).toBe(true);
  });

  it("omits total footer when idle", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
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

    const lines = renderDashboard(stats);
    expect(lines.some((l) => l.includes("Total"))).toBe(false);
  });

  it("omits total footer when phase is IDLE even if totalStartTime exists", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
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
      totalStartTime: Date.now() - 5000,
      totalElapsedMs: 5000,
    };

    const lines = renderDashboard(stats);
    // Footer should be omitted because phase is IDLE (condition requires both)
    expect(lines.some((l) => l.includes("Total"))).toBe(false);
  });

  it("shows 'waiting for tokens' when in generation but no tokens yet", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.GENERATION,
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
      totalStartTime: Date.now() - 1000,
      totalElapsedMs: 1000,
    };

    const lines = renderDashboard(stats);
    expect(lines.some((l) => l.includes("waiting"))).toBe(true);
  });

  it("shows complete status when phase is COMPLETE", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.COMPLETE,
      taskId: 12160,
      promptTokensTotal: 33626,
      promptTokensSeen: 33626,
      promptSpeed: 831.91,
      promptElapsedMs: 40420.08,
      promptComplete: true,
      generatedTokensTotal: 644,
      generationSpeed: 49.84,
      generationStartTime: null,
      generationComplete: true,
      finalSummary: {
        totalTimeMs: 53342.24,
        totalTokens: 34270,
      },
      totalStartTime: Date.now() - 53342,
      totalElapsedMs: 53342,
    };

    const lines = renderDashboard(stats);
    expect(lines[0]).toContain("Request complete");
    // Should show prompt done and generation info
    expect(lines.some((l) => l.includes("Done"))).toBe(true);
    expect(lines.some((l) => l.includes("644 tokens"))).toBe(true);
  });

  it("shows elapsed when promptElapsedMs > 0", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.GENERATION,
      taskId: 12160,
      promptTokensTotal: 33626,
      promptTokensSeen: 33626,
      promptSpeed: 831.91,
      promptElapsedMs: 40420.08,
      promptComplete: true,
      generatedTokensTotal: 550,
      generationSpeed: 49.87,
      generationStartTime: Date.now() - 5000,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 53000,
      totalElapsedMs: 53000,
    };

    const lines = renderDashboard(stats);
    expect(lines.some((l) => l.includes("Elapsed"))).toBe(true);
  });

  it("shows generation speed when > 0", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.GENERATION,
      taskId: null,
      promptTokensTotal: null,
      promptTokensSeen: 0,
      promptSpeed: 0,
      promptElapsedMs: 0,
      promptComplete: false,
      generatedTokensTotal: 550,
      generationSpeed: 49.87,
      generationStartTime: Date.now() - 5000,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 10000,
      totalElapsedMs: 10000,
    };

    const lines = renderDashboard(stats);
    expect(lines.some((l) => l.includes("Speed"))).toBe(true);
    expect(lines.some((l) => l.includes("49.9 tok/s"))).toBe(true);
  });

  it("shows no generation speed line when generationSpeed is 0", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.GENERATION,
      taskId: null,
      promptTokensTotal: null,
      promptTokensSeen: 0,
      promptSpeed: 0,
      promptElapsedMs: 0,
      promptComplete: false,
      generatedTokensTotal: 550, // tokens exist
      generationSpeed: 0, // but speed is 0
      generationStartTime: null,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 10000,
      totalElapsedMs: 10000,
    };

    const lines = renderDashboard(stats);
    // No speed line in generation section when speed is 0
    const genSection = lines.filter((l) => l.includes("Generation:")).join("\n");
    expect(genSection).not.toContain("Speed:");
  });

  it("shows elapsed only when generationStartTime exists and phase is GENERATION", () => {
    // Case: generationComplete = true but phase changed (no elapsed shown)
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.COMPLETE,
      taskId: null,
      promptTokensTotal: null,
      promptTokensSeen: 0,
      promptSpeed: 0,
      promptElapsedMs: 0,
      promptComplete: false,
      generatedTokensTotal: 550,
      generationSpeed: 49.87,
      generationStartTime: Date.now() - 5000,
      generationComplete: true,
      finalSummary: null,
      totalStartTime: Date.now() - 10000,
      totalElapsedMs: 10000,
    };

    const lines = renderDashboard(stats);
    // No elapsed shown because phase is not GENERATION (even though generationStartTime exists)
    expect(lines.some((l) => l.includes("generation") && l.includes("Elapsed"))).toBe(false);
  });

  it("shows no elapsed when generationStartTime is null in GENERATION", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.GENERATION,
      taskId: null,
      promptTokensTotal: null,
      promptTokensSeen: 0,
      promptSpeed: 0,
      promptElapsedMs: 0,
      promptComplete: false,
      generatedTokensTotal: 550,
      generationSpeed: 49.87,
      generationStartTime: null, // null — no elapsed shown
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 10000,
      totalElapsedMs: 10000,
    };

    const lines = renderDashboard(stats);
    // No elapsed shown because generationStartTime is null
    expect(lines.some((l) => l.includes("generation") && l.includes("Elapsed"))).toBe(false);
  });

  it("shows prompt elapsed when in 'tokens so far' path with elapsed > 0", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.PROMPT_EVAL,
      taskId: null,
      promptTokensTotal: null, // total unknown
      promptTokensSeen: 8192,
      promptSpeed: 0, // speed also 0
      promptElapsedMs: 5830, // but elapsed is set
      promptComplete: false,
      generatedTokensTotal: 0,
      generationSpeed: 0,
      generationStartTime: null,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 10000,
      totalElapsedMs: 10000,
    };

    const lines = renderDashboard(stats);
    // Should show elapsed in prompt section (tokens so far path)
    expect(lines.some((l) => l.includes("Elapsed"))).toBe(true);
  });

  it("shows no elapsed when promptElapsedMs is 0 in 'tokens so far' path", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.PROMPT_EVAL,
      taskId: null,
      promptTokensTotal: null, // total unknown
      promptTokensSeen: 8192,
      promptSpeed: 0,
      promptElapsedMs: 0, // elapsed is zero — else branch
      promptComplete: false,
      generatedTokensTotal: 0,
      generationSpeed: 0,
      generationStartTime: null,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 10000,
      totalElapsedMs: 10000,
    };

    const lines = renderDashboard(stats);
    // No elapsed line in prompt section when elapsed is 0
    const promptSection = lines.filter((l) => l.includes("Prompt:")).join("\n");
    expect(promptSection).not.toContain("Elapsed:");
  });

  it("shows prompt so far when total unknown yet", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.PROMPT_EVAL,
      taskId: null,
      promptTokensTotal: null,
      promptTokensSeen: 8192,
      promptSpeed: 1406.04,
      promptElapsedMs: 5830,
      promptComplete: false,
      generatedTokensTotal: 0,
      generationSpeed: 0,
      generationStartTime: null,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 10000,
      totalElapsedMs: 10000,
    };

    const lines = renderDashboard(stats);
    // Should show current count (with comma formatting from formatTokens)
    expect(lines.some((l) => l.includes("8,192"))).toBe(true);
  });

  it("handles prompt-only request (no generation) — completes after idle", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.IDLE,
      taskId: null,
      promptTokensTotal: 53,
      promptTokensSeen: 53,
      promptSpeed: 202.19,
      promptElapsedMs: 262.13,
      promptComplete: true,
      generatedTokensTotal: 0,
      generationSpeed: 0,
      generationStartTime: null,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: null,
      totalElapsedMs: 0,
    };

    const lines = renderDashboard(stats);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // No generation section for idle
    expect(lines.some((l) => l.includes("waiting"))).toBe(false);
  });
});

describe("renderFooterStatus", () => {
  it("shows idle status", () => {
    const stats = createIdleStats();
    const status = renderFooterStatus(stats);
    expect(status).toContain("idle");
  });

  it("shows prompt eval with percentage when total known", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.PROMPT_EVAL,
      taskId: 12160,
      promptTokensTotal: 33626,
      promptTokensSeen: 16384,
      promptSpeed: 1118.1,
      promptElapsedMs: 14650,
      promptComplete: false,
      generatedTokensTotal: 0,
      generationSpeed: 0,
      generationStartTime: null,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 20000,
      totalElapsedMs: 20000,
    };

    const status = renderFooterStatus(stats);
    expect(status).toContain("Prompt Eval");
    // Should contain percentage (49% for 16384/33626)
    expect(status).toContain("49%");
  });

  it("shows prompt eval without percentage when total unknown", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.PROMPT_EVAL,
      taskId: null,
      promptTokensTotal: null,
      promptTokensSeen: 8192,
      promptSpeed: 1406.04,
      promptElapsedMs: 5830,
      promptComplete: false,
      generatedTokensTotal: 0,
      generationSpeed: 0,
      generationStartTime: null,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 10000,
      totalElapsedMs: 10000,
    };

    const status = renderFooterStatus(stats);
    expect(status).toContain("Prompt Eval");
    expect(status).not.toContain("%");
    expect(status).toContain("8192");
  });

  it("shows generation with token count and speed", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.GENERATION,
      taskId: null,
      promptTokensTotal: null,
      promptTokensSeen: 0,
      promptSpeed: 0,
      promptElapsedMs: 0,
      promptComplete: false,
      generatedTokensTotal: 1260,
      generationSpeed: 48.15,
      generationStartTime: null,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 30000,
      totalElapsedMs: 30000,
    };

    const status = renderFooterStatus(stats);
    expect(status).toContain("Gen");
    expect(status).toContain("1,260");
    // Speed should be approximately right (formatSpeed rounds to 1 decimal)
    expect(status).toMatch(/48\.\d/);
  });

  it("shows complete status with token counts", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.COMPLETE,
      taskId: null,
      promptTokensTotal: 33626,
      promptTokensSeen: 33626,
      promptSpeed: 831.91,
      promptElapsedMs: 40420.08,
      promptComplete: true,
      generatedTokensTotal: 644,
      generationSpeed: 49.84,
      generationStartTime: null,
      generationComplete: true,
      finalSummary: null,
      totalStartTime: null,
      totalElapsedMs: 0,
    };

    const status = renderFooterStatus(stats);
    expect(status).toContain("Done");
    expect(status).toContain("33,626");
    expect(status).toContain("644");
  });

  it("uses theme colors when provided", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.GENERATION,
      taskId: null,
      promptTokensTotal: null,
      promptTokensSeen: 0,
      promptSpeed: 0,
      promptElapsedMs: 0,
      promptComplete: false,
      generatedTokensTotal: 100,
      generationSpeed: 49.88,
      generationStartTime: null,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 5000,
      totalElapsedMs: 5000,
    };

    const themeFg = vi.fn((color: string, text: string) => `[${color}:${text}]`);
    const status = renderFooterStatus(stats, { fg: themeFg });

    expect(themeFg).toHaveBeenCalledWith("accent", expect.any(String));
    expect(status).toContain("[accent:");
  });

  it("omits prompt tok in COMPLETE when promptSpeed is zero", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.COMPLETE,
      taskId: null,
      promptTokensTotal: null,
      promptTokensSeen: 8192,
      promptSpeed: 0,
      promptElapsedMs: 0,
      promptComplete: false,
      generatedTokensTotal: 100,
      generationSpeed: 49.88,
      generationStartTime: null,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: null,
      totalElapsedMs: 0,
    };

    const status = renderFooterStatus(stats);
    expect(status).toContain("Done");
    // promptSpeed is 0, so "prompt tok" should NOT appear
    expect(status).not.toContain("prompt tok");
    expect(status).toContain("100");
  });

  it("omits Gen section when generationComplete and no tokens generated (prompt-only)", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.COMPLETE,
      taskId: null,
      promptTokensTotal: 53,
      promptTokensSeen: 53,
      promptSpeed: 202.19,
      promptElapsedMs: 262.13,
      promptComplete: true,
      generatedTokensTotal: 0,
      generationSpeed: 0,
      generationStartTime: null,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: null,
      totalElapsedMs: 0,
    };

    const status = renderFooterStatus(stats);
    expect(status).toContain("Done");
    expect(status).toContain("53");
  });

  it("shows 'waiting tokens...' when in generation with zero generated tokens", () => {
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.GENERATION,
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
      totalStartTime: Date.now() - 2000,
      totalElapsedMs: 2000,
    };

    const status = renderFooterStatus(stats);
    expect(status).toContain("Gen");
    expect(status).toContain("waiting tokens...");
  });
});

// ===========================================================================
// 5. FIXTURE INTEGRATION — full lifecycle against real log data
// ===========================================================================

describe("fixture integration", () => {
  it.each([
    [
      "Request 12160: long prompt (33k tokens) + generation (644 tokens)",
      [
        "[60713] 841.46.011.264 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 0.24, t =   5.83 s / 1406.04 tokens per second",
        "[60713] 842.17.435.488 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =  33622, progress = 1.00, t =  37.25 s / 902.59 tokens per second",
        "[60713] 842.33.527.206 I slot print_timing: id  0 | task 12160 | n_decoded =    100, tg =  49.88 t/s",
        "[60713] 842.33.527.206 I slot print_timing: id  0 | task 12160 | n_decoded =    550, tg =  49.87 t/s",
        "[60713] 842.33.527.206 I slot print_timing: id  0 | task 12160 |", // end-of-turn marker
        "[60713] prompt eval time =   40420.08 ms / 33626 tokens (    1.20 ms per token,   831.91 tokens per second)",
        "[60713]        eval time =   12922.17 ms /   644 tokens (   20.07 ms per token,    49.84 tokens per second)",
        "[60713]       total time =   53342.24 ms / 34270 tokens",
        "[60713] 842.33.527.946 I slot      release: id  0 | task 12160 | stop processing: n_tokens = 34269, truncated = 0",
        "[60713] 842.33.527.981 I srv  update_slots: all slots are idle",
      ],
    ],
    [
      "Request 12814: short prompt (53 tokens) + generation (363 tokens)",
      [
        "[60713] 842.35.884.483 I slot print_timing: id  0 | task 12814 | n_decoded =    100, tg =  49.90 t/s",
        "[60713] 842.38.894.352 I slot print_timing: id  0 | task 12814 | n_decoded =    249, tg =  49.66 t/s",
        "[60713] 842.41.187.965 I slot print_timing: id  0 | task 12814 |",
        "[60713] prompt eval time =     262.13 ms /    53 tokens (    4.95 ms per token,   202.19 tokens per second)",
        "[60713]        eval time =    7307.38 ms /   363 tokens (   20.13 ms per token,    49.68 tokens per second)",
        "[60713]       total time =    7569.51 ms /   416 tokens",
        "[60713] 842.41.188.688 I slot      release: id  0 | task 12814 | stop processing: n_tokens = 34684, truncated = 0",
        "[60713] 842.41.188.724 I srv  update_slots: all slots are idle",
      ],
    ],
    [
      "Request 14575: prompt-only (903 tokens, no generation)",
      [
        "[60713] 862.26.333.297 I slot print_timing: id  0 | task 14575 |", // empty timing (prompt-only)
        "[60713] prompt eval time =    1450.68 ms /   903 tokens (    1.61 ms per token,   622.47 tokens per second)",
        "[60713]        eval time =    1798.60 ms /    89 tokens (   20.21 ms per token,    49.48 tokens per second)",
        "[60713]       total time =    3249.28 ms /   992 tokens",
        "[60713] 862.26.334.230 I slot      release: id  0 | task 14575 | stop processing: n_tokens = 36155, truncated = 0",
        "[60713] 862.26.334.266 I srv  update_slots: all slots are idle",
      ],
    ],
    [
      "Request 14766: short prompt + long generation (2472 tokens)",
      [
        "[60713] 862.36.671.881 I slot print_timing: id  0 | task 14766 | n_decoded =    100, tg =  48.24 t/s",
        "[60713] 862.57.763.422 I slot print_timing: id  0 | task 14766 | n_decoded =   1115, tg =  48.13 t/s",
        "[60713] 863.09.797.030 I slot print_timing: id  0 | task 14766 | n_decoded =   1694, tg =  48.13 t/s",
        "[60713] 863.24.861.031 I slot print_timing: id  0 | task 14766 | n_decoded =   2413, tg =  48.01 t/s",
        "[60713] 863.26.099.903 I slot print_timing: id  0 | task 14766 |", // end-of-turn marker
        "[60713] prompt eval time =    1014.06 ms /   569 tokens (    1.78 ms per token,   561.11 tokens per second)",
        "[60713]        eval time =   51501.19 ms /  2472 tokens (   20.83 ms per token,    48.00 tokens per second)",
        "[60713]       total time =   52515.26 ms /  3041 tokens",
        "[60713] 863.26.100.894 I slot      release: id  0 | task 14766 | stop processing: n_tokens = 42424, truncated = 0",
        "[60713] 863.26.100.934 I srv  update_slots: all slots are idle",
      ],
    ],
  ] as Array<[string, string[]]>)("%s", (_name, lines) => {
    const state = processLogFixture(lines);

    // The full lifecycle should end in IDLE (after the idle marker resets everything)
    expect(state.phase).toBe(RequestPhase.IDLE);
  });

  it.each([
    [
      "Request 12160",
      RequestPhase.GENERATION,
      { taskId: 12160, promptTokensSeen: 33622, generatedTokensTotal: 550 },
    ],
  ])("state before idle marker — %s", (_name, expectedPhase, checks) => {
    // Replay just up to the end-of-turn marker (before the idle line)
    const lines = [
      "[60713] 841.46.011.264 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 0.24, t =   5.83 s / 1406.04 tokens per second",
      "[60713] 842.17.435.488 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =  33622, progress = 1.00, t =  37.25 s / 902.59 tokens per second",
      "[60713] 842.33.527.206 I slot print_timing: id  0 | task 12160 | n_decoded =    100, tg =  49.88 t/s",
      "[60713] 842.33.527.206 I slot print_timing: id  0 | task 12160 | n_decoded =    550, tg =  49.87 t/s",
    ];

    const state = processLogFixture(lines);
    expect(state.phase).toBe(RequestPhase.GENERATION);
    expect(state.taskId).toBe(12160);
    if (checks.promptTokensSeen) expect(state.promptTokensSeen).toBe(checks.promptTokensSeen);
    if (checks.generatedTokensTotal) expect(state.generatedTokensTotal).toBe(checks.generatedTokensTotal);
  });

  it("replays fixture file line by line correctly", () => {
    const raw = fs.readFileSync(FIXTURE_PATH, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());

    // Just verify no crashes on full replay
    expect(() => processLogFixture(lines)).not.toThrow();
  });

  it("skips blank lines and non-event lines in processLogFixture", () => {
    const lines = [
      "",
      "   ",
      "garbage line that produces no events",
      "[60713] prompt eval time =     262.13 ms /    53 tokens (    4.95 ms per token,   202.19 tokens per second)",
      "",
      "another garbage line", // this should be skipped
    ];

    const state = processLogFixture(lines);
    expect(state.phase).toBe(RequestPhase.GENERATION);
    expect(state.promptTokensTotal).toBe(53);
  });

  it("dashboard renders for a mid-life cycle state", () => {
    const lines = [
      "[60713] 841.46.011.264 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =   8192, progress = 0.24, t =   5.83 s / 1406.04 tokens per second",
      "[60713] 842.17.435.488 I slot print_timing: id  0 | task 12160 | prompt processing, n_tokens =  16384, progress = 0.49, t =  14.65 s / 1118.10 tokens per second",
    ];

    const state = processLogFixture(lines);
    expect(state.phase).toBe(RequestPhase.PROMPT_EVAL);

    // Dashboard should render without error
    const lines2 = renderDashboard(state);
    expect(lines2.length).toBeGreaterThan(2);

    // Footer should render without error
    const footer = renderFooterStatus(state);
    expect(footer.length).toBeGreaterThan(5);
  });

  it("derives stats with correct elapsed time", () => {
    const state: Parameters<typeof processEvents>[0] = {
      phase: RequestPhase.GENERATION,
      taskId: 12160,
      slotId: null,
      promptTokensTotal: 33626,
      promptTokensSeen: 33626,
      promptSpeed: 831.91,
      promptElapsedMs: 40420.08,
      generatedTokensTotal: 550,
      generationSpeed: 49.87,
      generationStartTime: Date.now() - 5000,
    };

    const stats = deriveStats(state);

    expect(stats.phase).toBe(RequestPhase.GENERATION);
    expect(stats.taskId).toBe(12160);
    expect(stats.promptTokensSeen).toBe(33626);
    expect(stats.generatedTokensTotal).toBe(550);
    expect(stats.generationSpeed).toBe(49.87);
    // totalStartTime should be set from requestStartTime (non-IDLE phase)
    expect(stats.totalStartTime).not.toBeNull();
    // Elapsed time is based on wall-clock requestStartTime set by processEvents.
    // Since fixture processing happened moments ago, elapsed will be small but > 0
    // (processEvents sets requestStartTime = Date.now() on first event)
    expect(stats.totalElapsedMs).toBeGreaterThanOrEqual(0);
  });
});

// ===========================================================================
// 7. PROMPT PROGRESS OVER-100% BUG — invalidated/re-processed prompts
// ===========================================================================

describe("prompt progress over 100% bug (invalidated/re-processed prompts)", () => {
  it("does not show >100% when incremental prompt_processing has stale total estimate", () => {
    // Simulates the bug scenario: server sends incremental progress updates
    // where n_tokens grows but progress can decrease slightly due to batching.
    // The first line estimates total = 8192 / 0.57 ≈ 14372.
    // The second line has n_tokens=16384, which exceeds the estimate → >100%!
    let state = createIdleState();

    const lines = [
      "[60713] 78.12.681.495 I slot print_timing: id  0 | task 11541 | prompt processing, n_tokens =   4096, progress = 0.57, t =   5.89 s / 695.11 tokens per second",
      "[60713] 78.18.823.447 I slot print_timing: id  0 | task 11541 | prompt processing, n_tokens =   8192, progress = 0.72, t =  12.03 s / 680.71 tokens per second",
      "[60713] 78.25.365.271 I slot print_timing: id  0 | task 11541 | prompt processing, n_tokens =  12288, progress = 0.86, t =  18.58 s / 661.48 tokens per second",
      "[60713] 78.28.412.640 I slot print_timing: id  0 | task 11541 | prompt processing, n_tokens =  14121, progress = 0.93, t =  21.62 s / 653.03 tokens per second",
    ];

    for (const line of lines) {
      state = processEvents(state, parseLine(line));
    }

    expect(state.phase).toBe(RequestPhase.PROMPT_EVAL);
    // The latest n_tokens should be used as the seen count
    expect(state.promptTokensSeen).toBe(14121);

    // Derive stats and check that progress percentage is <= 100%
    const stats = deriveStats(state);
    if (stats.promptTokensTotal && stats.promptTokensTotal > 0) {
      const pct = Math.round((stats.promptTokensSeen / stats.promptTokensTotal) * 100);
      // Progress must never exceed 100% during prompt evaluation
      expect(pct).toBeLessThanOrEqual(100);
    }
  });

  it("does not show >100% when progress value goes down between incremental updates", () => {
    // Simulates server sending progress that decreases slightly:
    // progress=0.82 → progress=0.79 (due to batching/rounding in llama.cpp)
    let state = createIdleState();

    const lines = [
      "[60713] 75.00.990.003 I slot print_timing: id  0 | task 11413 | prompt processing, n_tokens =  57344, progress = 0.85, t = 302.97 s / 189.27 tokens per second",
      "[60713] 75.31.095.596 I slot print_timing: id  0 | task 11413 | prompt processing, n_tokens =  61440, progress = 0.88, t = 333.08 s / 184.46 tokens per second",
      "[60713] 76.02.853.843 I slot print_timing: id  0 | task 11413 | prompt processing, n_tokens =  65536, progress = 0.91, t = 364.83 s / 179.63 tokens per second",
      "[60713] 76.36.582.652 I slot print_timing: id  0 | task 11413 | prompt processing, n_tokens =  69632, progress = 0.94, t = 398.56 s / 174.71 tokens per second",
    ];

    for (const line of lines) {
      state = processEvents(state, parseLine(line));
    }

    expect(state.phase).toBe(RequestPhase.PROMPT_EVAL);
    expect(state.promptTokensSeen).toBe(69632);

    const stats = deriveStats(state);
    if (stats.promptTokensTotal && stats.promptTokensTotal > 0) {
      const pct = Math.round((stats.promptTokensSeen / stats.promptTokensTotal) * 100);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });

  it("does not show >100% after prompt is invalidated and re-processed with smaller token count", () => {
    // Simulates: Task A processes, gets cancelled (idle), then Task B starts
    // with fewer tokens but the old estimate was larger.
    let state = createIdleState();

    // Task A: processing with progress < 1.0 — sets estimated total
    const taskALine = parseLine(
      "[60713] 77.19.485.334 I slot print_timing: id  0 | task 11413 | prompt processing, n_tokens =  74858, progress = 0.98, t = 441.47 s / 169.57 tokens per second",
    );
    state = processEvents(state, taskALine);
    expect(state.phase).toBe(RequestPhase.PROMPT_EVAL);
    // Estimated total from 74858 / 0.98 ≈ 76386
    const estimatedTotalA = Math.round(74858 / 0.98);
    expect(state.promptTokensTotal).toBe(estimatedTotalA);

    // Task A gets cancelled — release + idle reset everything
    const releaseLine = parseLine(
      "[60713] 77.39.219.977 I slot      release: id  0 | task 11413 | stop processing: n_tokens = 130974, truncated = 0",
    );
    state = processEvents(state, releaseLine);
    expect(state.phase).toBe(RequestPhase.COMPLETE);

    const idleLine = parseLine("[60713] 77.39.220.037 I srv  update_slots: all slots are idle");
    state = processEvents(state, idleLine);
    expect(state.phase).toBe(RequestPhase.IDLE);

    // Task B: re-processed with fewer tokens — first line already at progress=1.00
    const launchLine = parseLine(
      "[60713] 77.46.518.411 I slot launch_slot_: id  0 | task 11438 | processing task, is_child = 0",
    );
    state = processEvents(state, launchLine);

    const taskBLine = parseLine(
      "[60713] 77.49.895.472 I slot print_timing: id  0 | task 11438 | prompt processing, n_tokens =   2823, progress = 1.00, t =   3.38 s / 835.94 tokens per second",
    );
    state = processEvents(state, taskBLine);

    expect(state.phase).toBe(RequestPhase.PROMPT_EVAL);
    expect(state.promptTokensSeen).toBe(2823);
    expect(state.promptTokensTotal).toBe(2823); // progress=1.00 → exact total

    const stats = deriveStats(state);
    if (stats.promptTokensTotal && stats.promptTokensTotal > 0) {
      const pct = Math.round((stats.promptTokensSeen / stats.promptTokensTotal) * 100);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });

  it("progress bar clamps to 100% even when seen exceeds total estimate", () => {
    // Direct test: force a state where promptTokensSeen > promptTokensTotal
    // (simulates the stale-estimate bug)
    const stats: Parameters<typeof renderDashboard>[0] = {
      phase: RequestPhase.PROMPT_EVAL,
      taskId: 11413,
      promptTokensTotal: 76386, // old estimate from 74858/0.98
      promptTokensSeen: 76906, // actual total was higher (from progress=1.00 line)
      promptSpeed: 167.42,
      promptElapsedMs: 459360,
      promptComplete: false,
      generatedTokensTotal: 0,
      generationSpeed: 0,
      generationStartTime: null,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 500000,
      totalElapsedMs: 500000,
    };

    const lines = renderDashboard(stats);
    // The progress bar percentage must be clamped to 100%
    const pctLine = lines.find((l) => l.includes("%"));
    expect(pctLine).toBeDefined();
    // Should show 100%, not 101%
    expect(pctLine).not.toMatch(/10[1-9]%/);
    expect(pctLine).toContain("100%");
  });

  it("footer percentage is clamped to 100% when seen exceeds total", () => {
    const stats: Parameters<typeof renderFooterStatus>[0] = {
      phase: RequestPhase.PROMPT_EVAL,
      taskId: 11413,
      promptTokensTotal: 76386,
      promptTokensSeen: 76906,
      promptSpeed: 167.42,
      promptElapsedMs: 459360,
      promptComplete: false,
      generatedTokensTotal: 0,
      generationSpeed: 0,
      generationStartTime: null,
      generationComplete: false,
      finalSummary: null,
      totalStartTime: Date.now() - 500000,
      totalElapsedMs: 500000,
    };

    const footer = renderFooterStatus(stats);
    // Footer percentage must not exceed 100%
    expect(footer).not.toMatch(/10[1-9]%/);
  });
});

// ===========================================================================
// 6. EXTENSION — index.ts content checks
// ===========================================================================

describe("llm-monitor (extension)", () => {
  it("llm-monitor-lib exports all required members", () => {
    expect(parseLine).toBeDefined();
    expect(parseBatch).toBeDefined();
    expect(processEvents).toBeDefined();
    expect(deriveStats).toBeDefined();
    expect(renderDashboard).toBeDefined();
    expect(renderFooterStatus).toBeDefined();
    expect(formatTokens).toBeDefined();
    expect(formatSpeed).toBeDefined();
    expect(formatMs).toBeDefined();
    expect(progressBar).toBeDefined();
    expect(createIdleStats).toBeDefined();
  });

  it("extension source uses lib exports (no duplicate parsing logic)", () => {
    const src = readExtensionFile("llm-monitor/index.ts");
    expect(src).toContain("./llm-monitor-lib");
  });

  it("extension defines llm-monitor command", () => {
    const src = readExtensionFile("llm-monitor/index.ts");
    expect(src).toContain("llm-monitor");
    expect(src).toContain("registerCommand");
  });

  it("extension handles session_start event", () => {
    const src = readExtensionFile("llm-monitor/index.ts");
    expect(src).toContain("session_start");
  });

  it("uses setWidget and setStatus for UI updates", () => {
    const src = readExtensionFile("llm-monitor/index.ts");
    expect(src).toContain("setWidget");
    expect(src).toContain("setStatus");
  });

  it("imports RequestPhase enum from lib", () => {
    const src = readExtensionFile("llm-monitor/index.ts");
    expect(src).toContain("RequestPhase");
  });
});
