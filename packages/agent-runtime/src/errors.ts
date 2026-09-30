/**
 * Why a turn was rejected for ending without a terminal tool call. The category is part of the
 * stable contract so operators and tests can tell a plain-text answer from an empty response.
 */
export type AgentProtocolViolation = "text-only" | "non-terminal-tool" | "empty-or-no-terminal-tool";

export class AgentRuntimeError extends Error {
  declare public cause?: unknown;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "AgentRuntimeError";
    this.cause = options.cause;
  }
}

export class AgentBusyError extends AgentRuntimeError {
  constructor() {
    super("Agent is busy");
    this.name = "AgentBusyError";
  }
}

export class ToolConflictError extends AgentRuntimeError {
  constructor(toolName: string) {
    super(`Tool conflict: ${toolName}`);
    this.name = "ToolConflictError";
  }
}

/**
 * Raised when a turn ends without the terminal tool call its caller requires. Plain assistant text
 * is internal reasoning, never a platform reply, so it cannot satisfy the invariant.
 */
export class AgentProtocolError extends AgentRuntimeError {
  readonly violation: AgentProtocolViolation;

  constructor(violation: AgentProtocolViolation) {
    super(`Agent turn ended without a terminal tool call (${violation})`);
    this.name = "AgentProtocolError";
    this.violation = violation;
  }
}

export function formatErrorCause(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

export function classifyRuntimeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }

  return "UnknownError";
}
