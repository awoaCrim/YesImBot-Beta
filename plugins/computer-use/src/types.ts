export type ComputerToolType = "computer" | "computer_use_preview";

export type ComputerAction =
  | {
      readonly type: "click";
      readonly button: "left" | "right" | "wheel" | "back" | "forward";
      readonly x: number;
      readonly y: number;
      readonly keys?: readonly string[] | null;
    }
  | { readonly type: "double_click"; readonly x: number; readonly y: number; readonly keys?: readonly string[] | null }
  | { readonly type: "drag"; readonly path: readonly { readonly x: number; readonly y: number }[]; readonly keys?: readonly string[] | null }
  | { readonly type: "keypress"; readonly keys: readonly string[] }
  | { readonly type: "move"; readonly x: number; readonly y: number; readonly keys?: readonly string[] | null }
  | { readonly type: "screenshot" }
  | {
      readonly type: "scroll";
      readonly x: number;
      readonly y: number;
      readonly scrollX: number;
      readonly scrollY: number;
      readonly keys?: readonly string[] | null;
    }
  | { readonly type: "type"; readonly text: string }
  | { readonly type: "wait" };

export type ComputerUseResult =
  | {
      readonly ok: true;
      readonly status: "completed" | "incomplete";
      readonly summary: string;
      readonly steps: number;
      readonly safetyChecks?: readonly ComputerSafetyCheck[];
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code:
          | "aborted"
          | "timeout"
          | "provider_error"
          | "driver_unavailable"
          | "action_failed"
          | "safety_check_required"
          | "invalid_response"
          | "step_limit";
        readonly message: string;
        readonly retryable: boolean;
      };
      readonly steps: number;
      readonly safetyChecks?: readonly ComputerSafetyCheck[];
    };

export interface ComputerSafetyCheck {
  readonly id: string;
  readonly code?: string | null;
  readonly message?: string | null;
}

export interface ComputerScreenshot {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
}

export interface ComputerDriver {
  execute(actions: readonly ComputerAction[], signal: AbortSignal): Promise<ComputerScreenshot>;
  close(): Promise<void>;
}

export interface ComputerUseInput {
  readonly task: string;
}

export interface ComputerUseRunnerResult {
  readonly result: ComputerUseResult;
  readonly screenshot?: ComputerScreenshot;
}
