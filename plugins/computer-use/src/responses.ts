import type { ComputerAction, ComputerDriver, ComputerSafetyCheck, ComputerScreenshot, ComputerToolType, ComputerUseRunnerResult } from "./types.js";

const MAX_RESPONSE_TEXT = 4_000;
const MAX_SAFETY_CHECKS = 16;

export interface ResponsesComputerConfig {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly model: string;
  readonly toolType?: ComputerToolType;
  readonly environment?: "computer" | "browser";
  readonly displayWidth?: number;
  readonly displayHeight?: number;
  readonly maxSteps: number;
}

export interface ResponsesRequester {
  request(input: string | readonly ComputerCallOutput[], previousResponseId: string | undefined, signal: AbortSignal): Promise<ResponsesResponse>;
}

export interface ResponsesResponse {
  readonly id?: string;
  readonly status?: string;
  readonly output?: readonly unknown[];
  readonly output_text?: string;
  readonly error?: unknown;
}

export interface ComputerCallOutput {
  readonly type: "computer_call_output";
  readonly call_id: string;
  readonly output: {
    readonly type: "computer_screenshot";
    readonly image_url: string;
    readonly detail: "original";
  };
}

interface ComputerCall {
  readonly type: "computer_call";
  readonly id?: string;
  readonly call_id?: string;
  readonly status?: string;
  readonly action?: ComputerAction | null;
  readonly actions?: readonly ComputerAction[] | null;
  readonly pending_safety_checks?: readonly ComputerSafetyCheck[] | null;
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

export function createResponsesRequester(config: ResponsesComputerConfig, fetcher: typeof fetch = fetch): ResponsesRequester {
  const baseURL = normalizeBaseURL(config.baseURL);
  const tool = createComputerTool(config);

  return {
    async request(input, previousResponseId, signal) {
      const body = {
        model: config.model,
        store: true,
        tools: [tool],
        input,
        ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId }),
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
        // Do not copy the provider response body into logs or model-visible output: it may contain
        // request metadata or echoed credentials from a compatible endpoint.
        throw new ResponsesApiError(response.status);
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
  readonly maxSteps: number;
  readonly signal: AbortSignal;
}): Promise<ComputerUseRunnerResult> {
  let response = await options.requester.request(options.prompt, undefined, options.signal);
  let previousResponseId = response.id;
  let screenshot: ComputerScreenshot | undefined;

  for (let step = 0; step < options.maxSteps; step += 1) {
    throwIfAborted(options.signal);
    const calls = extractComputerCalls(response.output);
    if (calls.length === 0) {
      if (response.status === "failed" || response.error !== undefined) {
        return {
          result: {
            ok: false,
            error: { code: "provider_error", message: "The native computer model returned a failed response.", retryable: true },
            steps: step,
          },
          ...(screenshot ? { screenshot } : {}),
        };
      }
      const summary = extractResponseText(response);
      if (response.status === "incomplete") {
        return {
          result: { ok: true, status: "incomplete", summary: summary || "Native computer task stopped before completion.", steps: step },
          ...(screenshot ? { screenshot } : {}),
        };
      }
      return {
        result: { ok: true, status: "completed", summary: summary || "Native computer task completed.", steps: step },
        ...(screenshot ? { screenshot } : {}),
      };
    }

    const pendingChecks = calls.flatMap((call) => normalizeSafetyChecks(call.pending_safety_checks));
    if (pendingChecks.length > 0) {
      return {
        result: {
          ok: false,
          error: {
            code: "safety_check_required",
            message: "The computer model requested a safety confirmation before a consequential action. The action was not executed.",
            retryable: false,
          },
          steps: step,
          safetyChecks: pendingChecks,
        },
        ...(screenshot ? { screenshot } : {}),
      };
    }

    const outputs: ComputerCallOutput[] = [];
    for (const call of calls) {
      const actions = extractActions(call);
      const callId = call.call_id ?? call.id;
      if (!callId || actions.length === 0) {
        return {
          result: {
            ok: false,
            error: { code: "invalid_response", message: "The computer model returned an invalid action call.", retryable: false },
            steps: step,
          },
          ...(screenshot ? { screenshot } : {}),
        };
      }

      screenshot = await options.driver.execute(actions, options.signal);
      outputs.push({
        type: "computer_call_output",
        call_id: callId,
        output: {
          type: "computer_screenshot",
          image_url: `data:${screenshot.mediaType};base64,${Buffer.from(screenshot.bytes).toString("base64")}`,
          detail: "original",
        },
      });
    }

    if (!previousResponseId) {
      return {
        result: {
          ok: false,
          error: { code: "invalid_response", message: "The computer model response has no continuation id.", retryable: false },
          steps: step + 1,
        },
        ...(screenshot ? { screenshot } : {}),
      };
    }

    response = await options.requester.request(outputs, previousResponseId, options.signal);
    previousResponseId = response.id ?? previousResponseId;
  }

  return {
    result: {
      ok: false,
      error: { code: "step_limit", message: "The native computer task reached its step limit before completion.", retryable: false },
      steps: options.maxSteps,
    },
    ...(screenshot ? { screenshot } : {}),
  };
}

function createComputerTool(config: ResponsesComputerConfig): Record<string, unknown> {
  if (config.toolType === "computer_use_preview") {
    return {
      type: "computer_use_preview",
      display_width: positiveDimension(config.displayWidth, 1280),
      display_height: positiveDimension(config.displayHeight, 800),
      environment: config.environment ?? "computer",
    };
  }
  return { type: "computer" };
}

function extractComputerCalls(output: readonly unknown[] | undefined): ComputerCall[] {
  if (!output) return [];
  return output.filter((item): item is ComputerCall => isRecord(item) && item.type === "computer_call");
}

function extractActions(call: ComputerCall): readonly ComputerAction[] {
  if (Array.isArray(call.actions)) return call.actions.filter(isComputerAction);
  return call.action && isComputerAction(call.action) ? [call.action] : [];
}

function normalizeSafetyChecks(value: readonly ComputerSafetyCheck[] | null | undefined): ComputerSafetyCheck[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_SAFETY_CHECKS).flatMap((check) => {
    if (!isRecord(check) || typeof check.id !== "string") return [];
    return [
      {
        id: check.id.slice(0, 128),
        ...(typeof check.code === "string" ? { code: check.code.slice(0, 128) } : {}),
        ...(typeof check.message === "string" ? { message: check.message.slice(0, 512) } : {}),
      },
    ];
  });
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

function isComputerAction(value: unknown): value is ComputerAction {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  const keysValid = value.keys === undefined || value.keys === null || (Array.isArray(value.keys) && value.keys.every((key) => typeof key === "string"));
  switch (value.type) {
    case "click":
      return (
        isNumber(value.x) && isNumber(value.y) && isString(value.button) && ["left", "right", "wheel", "back", "forward"].includes(value.button) && keysValid
      );
    case "double_click":
    case "move":
      return isNumber(value.x) && isNumber(value.y) && keysValid;
    case "drag":
      return Array.isArray(value.path) && value.path.every((point) => isRecord(point) && isNumber(point.x) && isNumber(point.y)) && keysValid;
    case "keypress":
      return Array.isArray(value.keys) && value.keys.every((key) => typeof key === "string");
    case "screenshot":
    case "wait":
      return true;
    case "scroll":
      return isNumber(value.x) && isNumber(value.y) && isNumber(value.scrollX) && isNumber(value.scrollY) && keysValid;
    case "type":
      return typeof value.text === "string";
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
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
