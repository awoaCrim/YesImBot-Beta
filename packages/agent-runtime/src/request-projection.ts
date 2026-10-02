import { createHash } from "node:crypto";

import type { ModelMessage } from "ai";

/** Request-only provenance. These fields are never serialized to the provider or durable log. */
export interface AgentRequestOrigin {
  readonly kind: "mandatory" | "live" | "history" | "summary" | "recall" | "loaded";
  readonly sourceEntryIds: readonly string[];
  readonly timestamp?: number;
  readonly blockId?: string;
}

/** Unknown or rewritten messages are protected rather than guessed from their role or position. */
export class AgentRequestProjection {
  private readonly origins = new WeakMap<object, { origin: AgentRequestOrigin; fingerprint: string }>();

  public register(message: object, origin: AgentRequestOrigin): void {
    this.origins.set(message, {
      origin: Object.freeze({ ...origin, sourceEntryIds: Object.freeze([...origin.sourceEntryIds]) }),
      fingerprint: fingerprint(message),
    });
  }

  public origin(message: object): AgentRequestOrigin | undefined {
    const value = this.origins.get(message);
    return value && value.fingerprint === fingerprint(message) ? value.origin : undefined;
  }

  public inherit(message: object, sources: readonly object[]): void {
    const origins = sources.map((source) => this.origin(source));
    if (origins.length === 0 || origins.some((origin) => origin === undefined)) {
      this.origins.delete(message);
      return;
    }
    const known = origins as AgentRequestOrigin[];
    const first = known[0]!;
    const kind = known.every((origin) => origin.kind === first.kind)
      ? first.kind
      : known.some((origin) => origin.kind === "mandatory" || origin.kind === "live")
        ? "mandatory"
        : "history";
    this.register(message, {
      kind,
      sourceEntryIds: [...new Set(known.flatMap((origin) => [...origin.sourceEntryIds]))],
      ...(first.timestamp === undefined ? {} : { timestamp: first.timestamp }),
      ...(known.every((origin) => origin.blockId === first.blockId) && first.blockId ? { blockId: first.blockId } : {}),
    });
  }

  public describe(messages: readonly ModelMessage[]): readonly (AgentRequestOrigin | undefined)[] {
    return messages.map((message) => this.origin(message));
  }
}

function fingerprint(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
