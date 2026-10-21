import type { ComputerAction, ComputerDriver, ComputerSafetyCheck, ComputerScreenshot, ComputerUseRunnerResult } from "./types.js";

const MAX_RESPONSE_TEXT = 4_000;
const MAX_SAFETY_CHECKS = 16;
const MAX_TEXT_LENGTH = 4_000;
const MAX_KEYS = 12;
const MAX_DRAG_POINTS = 128;
const MAX_COORDINATE = 16_383;
const MAX_CALLS_PER_STEP = 8;
const MAX_PROVIDER_MESSAGE = 200;
const MAX_REPLAY_TURNS = 4;
const OMITTED_SCREENSHOT_TEXT = "Earlier screenshots were omitted to keep this stateless request bounded; use the latest screenshot as ground truth.";
const CONFIRMATION_TOOL = "request_confirmation";

const CONTINUE_PROMPT = [
  "The latest screenshot after the previous actions is attached.",
  "Continue the task. If the goal is already verified on screen, answer with a concise factual summary and do not call any tool.",
].join(" ");

/** One item of the request history that is replayed on every stateless request. */
export type ResponseInputItem =
  | { readonly role: "user"; readonly content: readonly ResponseContentPart[] }
  | { readonly type: "function_call"; readonly call_id: string; readonly name: string; readonly arguments: string }
  | { readonly type: "function_call_output"; readonly call_id: string; readonly output: string };

export type ResponseContentPart = { readonly type: "input_text"; readonly text: string } | { readonly type: "input_image"; readonly image_url: string };

export interface ResponsesComputerConfig {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly model: string;
  readonly displayWidth?: number;
  readonly displayHeight?: number;
}

export interface ResponsesRequester {
  request(input: readonly ResponseInputItem[], signal: AbortSignal): Promise<ResponsesResponse>;
}

export interface ResponsesResponse {
  readonly id?: string;
  readonly status?: string;
  readonly output?: readonly unknown[];
  readonly output_text?: string;
  readonly error?: unknown;
}

interface FunctionCall {
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

export class ResponsesApiError extends Error {
  public constructor(
    public readonly status: number | undefined,
    message = "Responses API request failed",
  ) {
    super(message);
    this.name = "ResponsesApiError";
  }
}

class InvalidToolCall extends Error {}

export function createResponsesRequester(config: ResponsesComputerConfig, fetcher: typeof fetch = fetch): ResponsesRequester {
  const baseURL = normalizeBaseURL(config.baseURL);
  const tools = createFunctionTools(config);

  return {
    async request(input, signal) {
      // The provider used here rejects `previous_response_id` continuations for function outputs, so the
      // loop replays the whole bounded history itself and never depends on server-side response storage.
      const body = {
        model: config.model,
        store: false,
        tools,
        input,
      };
      let response: Response;
      try {
        response = await fetcher(`${baseURL}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (cause) {
        if (signal.aborted) throw abortError();
        throw new ResponsesApiError(undefined, cause instanceof Error ? cause.message : "Responses API request failed");
      }

      if (!response.ok) {
        // Provider bodies can echo request metadata, so only a redacted and truncated message is surfaced.
        const detail = await providerErrorMessage(response, config.apiKey);
        throw new ResponsesApiError(response.status, detail ? `Responses API HTTP ${response.status}: ${detail}` : undefined);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ResponsesApiError(response.status, "Responses API returned invalid JSON");
      }
      if (!isRecord(payload)) throw new ResponsesApiError(response.status, "Responses API returned an invalid response");
      return payload as ResponsesResponse;
    },
  };
}

export async function runResponsesComputerUse(options: {
  readonly prompt: string;
  readonly requester: ResponsesRequester;
  readonly driver: ComputerDriver;
  readonly signal: AbortSignal;
}): Promise<ComputerUseRunnerResult> {
  const history: ResponseInputItem[] = [];
  let screenshot = await options.driver.execute([], options.signal);
  let steps = 0;

  for (;;) {
    throwIfAborted(options.signal);
    const turn = userTurn(steps === 0 ? options.prompt : CONTINUE_PROMPT, screenshot);
    const response = await options.requester.request(compactReplayHistory(history, turn), options.signal);
    steps += 1;

    const calls = extractFunctionCalls(response.output);
    if (calls.length === 0) {
      if (response.status === "failed" || (response.error !== undefined && response.error !== null)) {
        return {
          result: { ok: false, error: { code: "provider_error", message: "The computer model returned a failed response.", retryable: true }, steps },
          screenshot,
        };
      }
      const summary = extractResponseText(response);
      const status = response.status === "incomplete" ? "incomplete" : "completed";
      return {
        result: {
          ok: true,
          status,
          summary: summary || (status === "incomplete" ? "Computer task stopped before completion." : "Computer task completed."),
          steps,
        },
        screenshot,
      };
    }

    if (calls.length > MAX_CALLS_PER_STEP) {
      return {
        result: {
          ok: false,
          error: { code: "invalid_response", message: "The computer model requested too many actions in one step.", retryable: false },
          steps,
        },
        screenshot,
      };
    }

    const confirmation = calls.find((call) => call.name === CONFIRMATION_TOOL);
    if (confirmation) {
      return {
        result: {
          ok: false,
          error: {
            code: "safety_check_required",
            message: "The computer model asked for confirmation before a consequential action. No action was executed.",
            retryable: false,
          },
          steps,
          safetyChecks: [confirmationCheck(confirmation)],
        },
        screenshot,
      };
    }

    const planned: { call: FunctionCall; actions: readonly ComputerAction[] }[] = [];
    for (const call of calls) {
      try {
        planned.push({ call, actions: buildActions(call.name, call.arguments) });
      } catch (cause) {
        return {
          result: {
            ok: false,
            error: {
              code: "invalid_response",
              message:
                cause instanceof InvalidToolCall
                  ? `The computer model sent an invalid action: ${cause.message}`
                  : "The computer model sent an unparsable action.",
              retryable: false,
            },
            steps,
          },
          screenshot,
        };
      }
    }

    const outputs: ResponseInputItem[] = [];
    for (const { call, actions } of planned) {
      screenshot = await options.driver.execute(actions, options.signal);
      outputs.push({ type: "function_call_output", call_id: call.call_id, output: describeActions(call.name, actions) });
    }

    history.push(
      turn,
      ...calls.map((call): ResponseInputItem => ({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments })),
      ...outputs,
    );
  }
}

function createFunctionTools(config: ResponsesComputerConfig): readonly unknown[] {
  const width = positiveDimension(config.displayWidth, 1280);
  const height = positiveDimension(config.displayHeight, 800);
  const coordinateNote = `Screen coordinates are in screenshot pixels: x is 0-${width - 1}, y is 0-${height - 1}.`;
  const keysSchema = { type: "array", items: { type: "string" }, maxItems: MAX_KEYS, description: 'Modifier keys held during the action, e.g. ["CTRL"].' };

  return [
    functionTool(
      "desktop_move",
      `Move the mouse pointer. ${coordinateNote}`,
      {
        x: { type: "number" },
        y: { type: "number" },
        keys: keysSchema,
      },
      ["x", "y"],
    ),
    functionTool(
      "desktop_click",
      `Click once at a screen position. ${coordinateNote}`,
      {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right", "wheel", "back", "forward"] },
        keys: keysSchema,
      },
      ["x", "y"],
    ),
    functionTool(
      "desktop_double_click",
      `Double click at a screen position. ${coordinateNote}`,
      {
        x: { type: "number" },
        y: { type: "number" },
        keys: keysSchema,
      },
      ["x", "y"],
    ),
    functionTool(
      "desktop_drag",
      `Drag along an ordered list of points. ${coordinateNote}`,
      {
        path: {
          type: "array",
          minItems: 2,
          maxItems: MAX_DRAG_POINTS,
          items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false },
        },
        keys: keysSchema,
      },
      ["path"],
    ),
    functionTool(
      "desktop_type",
      "Type text into the currently focused input. Use desktop_click first to focus the right field.",
      {
        text: { type: "string", maxLength: MAX_TEXT_LENGTH },
      },
      ["text"],
    ),
    functionTool(
      "desktop_key",
      'Press one key combination, e.g. ["CTRL","L"] or ["Return"].',
      {
        keys: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_KEYS },
      },
      ["keys"],
    ),
    functionTool(
      "desktop_scroll",
      `Scroll at a screen position. ${coordinateNote}`,
      {
        x: { type: "number" },
        y: { type: "number" },
        scrollX: { type: "number" },
        scrollY: { type: "number" },
        keys: keysSchema,
      },
      ["x", "y", "scrollX", "scrollY"],
    ),
    functionTool("desktop_screenshot", "Take a fresh screenshot without changing anything. A screenshot is already attached after every action batch.", {}),
    functionTool("desktop_wait", "Wait about a second for the desktop to settle, e.g. after launching an application.", {
      seconds: { type: "number", minimum: 0.25, maximum: 5, description: "Requested pause; the executor waits a fixed short interval." },
    }),
    functionTool(
      CONFIRMATION_TOOL,
      "Ask the user for confirmation before a consequential action: purchases, payments, account or credential changes, deleting important data, or sending messages to other people. Calling this executes nothing.",
      { reason: { type: "string", maxLength: 512 } },
      ["reason"],
    ),
  ];
}

function functionTool(name: string, description: string, properties: Record<string, unknown>, required: readonly string[] = []): unknown {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties,
      ...(required.length === 0 ? {} : { required }),
      additionalProperties: false,
    },
  };
}

function userTurn(text: string, screenshot: ComputerScreenshot): ResponseInputItem {
  return {
    role: "user",
    content: [
      { type: "input_text", text },
      { type: "input_image", image_url: `data:${screenshot.mediaType};base64,${Buffer.from(screenshot.bytes).toString("base64")}` },
    ],
  };
}

function compactReplayHistory(history: readonly ResponseInputItem[], currentTurn: ResponseInputItem): readonly ResponseInputItem[] {
  const segments = splitReplaySegments([...history, currentTurn]);
  const latest = segments[segments.length - 1];
  const selected = segments.length > MAX_REPLAY_TURNS ? [segments[0]!, ...segments.slice(-MAX_REPLAY_TURNS)] : segments;
  return selected.flatMap((segment) =>
    segment.map((item) => {
      if (!("role" in item) || item.role !== "user" || segment === latest) return item;
      return {
        role: "user" as const,
        content: [...item.content.filter((part) => part.type === "input_text"), { type: "input_text" as const, text: OMITTED_SCREENSHOT_TEXT }],
      };
    }),
  );
}

function splitReplaySegments(items: readonly ResponseInputItem[]): ResponseInputItem[][] {
  const segments: ResponseInputItem[][] = [];
  let current: ResponseInputItem[] = [];
  for (const item of items) {
    if ("role" in item && item.role === "user") {
      if (current.length > 0) segments.push(current);
      current = [item];
    } else {
      current.push(item);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function buildActions(name: string, rawArguments: string): readonly ComputerAction[] {
  const args = parseArguments(rawArguments);
  switch (name) {
    case "desktop_move": {
      const keys = modifierKeys(args.keys);
      return [{ type: "move", x: coordinate(args.x, "x"), y: coordinate(args.y, "y"), ...(keys ? { keys } : {}) }];
    }
    case "desktop_click": {
      const keys = modifierKeys(args.keys);
      const button = args.button === undefined ? "left" : args.button;
      if (button !== "left" && button !== "right" && button !== "wheel" && button !== "back" && button !== "forward") {
        throw new InvalidToolCall("desktop_click.button");
      }
      return [{ type: "click", button, x: coordinate(args.x, "x"), y: coordinate(args.y, "y"), ...(keys ? { keys } : {}) }];
    }
    case "desktop_double_click": {
      const keys = modifierKeys(args.keys);
      return [{ type: "double_click", x: coordinate(args.x, "x"), y: coordinate(args.y, "y"), ...(keys ? { keys } : {}) }];
    }
    case "desktop_drag": {
      const keys = modifierKeys(args.keys);
      if (!Array.isArray(args.path) || args.path.length < 2 || args.path.length > MAX_DRAG_POINTS) throw new InvalidToolCall("desktop_drag.path");
      const path = args.path.map((point) => {
        if (!isRecord(point)) throw new InvalidToolCall("desktop_drag.path");
        return { x: coordinate(point.x, "x"), y: coordinate(point.y, "y") };
      });
      return [{ type: "drag", path, ...(keys ? { keys } : {}) }];
    }
    case "desktop_type": {
      if (typeof args.text !== "string" || args.text.length === 0 || args.text.length > MAX_TEXT_LENGTH) throw new InvalidToolCall("desktop_type.text");
      return [{ type: "type", text: args.text }];
    }
    case "desktop_key": {
      const keys = keyList(args.keys);
      if (keys.length === 0 || keys.length > MAX_KEYS) throw new InvalidToolCall("desktop_key.keys");
      return [{ type: "keypress", keys }];
    }
    case "desktop_scroll": {
      const keys = modifierKeys(args.keys);
      return [
        {
          type: "scroll",
          x: coordinate(args.x, "x"),
          y: coordinate(args.y, "y"),
          scrollX: finiteNumber(args.scrollX, "scrollX"),
          scrollY: finiteNumber(args.scrollY, "scrollY"),
          ...(keys ? { keys } : {}),
        },
      ];
    }
    case "desktop_screenshot":
      return [{ type: "screenshot" }];
    case "desktop_wait": {
      const seconds = args.seconds === undefined ? 1 : finiteNumber(args.seconds, "seconds");
      if (seconds < 0.25 || seconds > 5) throw new InvalidToolCall("desktop_wait.seconds");
      return [{ type: "wait" }];
    }
    default:
      throw new InvalidToolCall(name);
  }
}

function parseArguments(rawArguments: string): Record<string, unknown> {
  if (rawArguments.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new InvalidToolCall("arguments are not valid JSON");
  }
  if (!isRecord(parsed)) throw new InvalidToolCall("arguments are not an object");
  return parsed;
}

function coordinate(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_COORDINATE) throw new InvalidToolCall(name);
  return Math.round(value);
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000) throw new InvalidToolCall(name);
  return value;
}

function keyList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((key) => typeof key === "string" && key.length > 0 && key.length <= 32)) {
    throw new InvalidToolCall("keys");
  }
  return value;
}

function modifierKeys(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const keys = keyList(value);
  if (keys.length === 0) return undefined;
  if (keys.length > MAX_KEYS) throw new InvalidToolCall("keys");
  return keys;
}

function describeActions(name: string, actions: readonly ComputerAction[]): string {
  const action = actions[0];
  switch (action?.type) {
    case "click":
      return `ok: ${name} ${action.button} at (${action.x}, ${action.y})`;
    case "double_click":
      return `ok: ${name} at (${action.x}, ${action.y})`;
    case "move":
      return `ok: ${name} (${action.x}, ${action.y})`;
    case "drag":
      return `ok: ${name} through ${action.path.length} points`;
    case "type":
      return `ok: ${name} ${action.text.length} characters`;
    case "keypress":
      return `ok: ${name} ${action.keys.join("+")}`;
    case "scroll":
      return `ok: ${name} (${action.scrollX}, ${action.scrollY}) at (${action.x}, ${action.y})`;
    case "screenshot":
      return "ok: screenshot captured";
    case "wait":
      return "ok: waited";
    default:
      return `ok: ${name}`;
  }
}

function confirmationCheck(call: FunctionCall): ComputerSafetyCheck {
  let reason: string | undefined;
  try {
    const args = parseArguments(call.arguments);
    if (typeof args.reason === "string" && args.reason.trim()) reason = args.reason.trim().slice(0, 512);
  } catch {
    reason = undefined;
  }
  return {
    id: call.call_id.slice(0, 128),
    code: "confirmation_requested",
    ...(reason ? { message: reason } : {}),
  };
}

function extractFunctionCalls(output: readonly unknown[] | undefined): FunctionCall[] {
  if (!output) return [];
  const calls: FunctionCall[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "function_call") continue;
    if (typeof item.name !== "string" || item.name.length === 0) continue;
    if (typeof item.call_id !== "string" || item.call_id.length === 0) continue;
    calls.push({ call_id: item.call_id, name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : "" });
  }
  return calls.slice(0, MAX_SAFETY_CHECKS);
}

function extractResponseText(response: ResponsesResponse): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text.trim().slice(0, MAX_RESPONSE_TEXT);
  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRecord(part)) continue;
      const text = typeof part.text === "string" ? part.text : typeof part.value === "string" ? part.value : undefined;
      if (text) chunks.push(text);
    }
  }
  return chunks.join("\n").trim().slice(0, MAX_RESPONSE_TEXT);
}

async function providerErrorMessage(response: Response, apiKey: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (text.length === 0 || text.length > 8_000) return undefined;
  let message: string | undefined;
  try {
    const payload: unknown = JSON.parse(text);
    if (isRecord(payload)) {
      const error = payload.error;
      if (typeof error === "string") message = error;
      else if (isRecord(error)) {
        message =
          [error.message, error.code, error.type].filter((value): value is string => typeof value === "string" && value.length > 0).join(" | ") || undefined;
      } else if (typeof payload.message === "string") message = payload.message;
    }
  } catch {
    return undefined;
  }
  if (!message) return undefined;
  return redact(message, apiKey).slice(0, MAX_PROVIDER_MESSAGE);
}

function redact(value: string, apiKey: string): string {
  const withoutKey = apiKey.length > 0 ? value.split(apiKey).join("***") : value;
  return withoutKey.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveDimension(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 && value! <= 16_384 ? value! : fallback;
}

function normalizeBaseURL(value: string | undefined): string {
  const baseURL = (value ?? "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseURL)) throw new Error("computer-use baseURL 必须是 HTTP(S) URL");
  return baseURL;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException("The computer task was aborted.", "AbortError");
}
