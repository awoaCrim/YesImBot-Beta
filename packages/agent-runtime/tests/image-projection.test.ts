import { afterEach, describe, expect, it, vi } from "vitest";

import { EphemeralImageProjectionStore } from "../src/image-projection.js";

const FIRST = new Uint8Array([1, 2, 3]);
const SECOND = new Uint8Array([4, 5, 6]);

function stage(store: EphemeralImageProjectionStore, toolCallId: string, bytes: Uint8Array, options: { turnId?: string; signal?: AbortSignal } = {}): boolean {
  return store.stage({ toolCallId, turnId: options.turnId ?? "turn-1", bytes, mediaType: "image/png", signal: options.signal });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EphemeralImageProjectionStore", () => {
  it("keeps repeated current-turn projections alive only within the sliding TTL", async () => {
    vi.useFakeTimers();
    const store = new EphemeralImageProjectionStore({ ttlMs: 50, capacity: 2 });
    stage(store, "call", FIRST);

    await vi.advanceTimersByTimeAsync(40);
    expect(store.get("call")?.bytes).toBe(FIRST);
    await vi.advanceTimersByTimeAsync(40);
    expect(store.get("call")?.bytes).toBe(FIRST);
    await vi.advanceTimersByTimeAsync(51);
    expect(store.get("call")).toBeUndefined();
  });

  it("evicts the oldest call when capacity is reached", () => {
    const store = new EphemeralImageProjectionStore({ capacity: 2 });
    stage(store, "first", FIRST);
    stage(store, "second", SECOND);
    stage(store, "third", FIRST);

    expect(store.get("first")).toBeUndefined();
    expect(store.get("second")?.bytes).toBe(SECOND);
    expect(store.get("third")?.bytes).toBe(FIRST);
    store.clearAll();
  });

  it("cleans up on abort and rejects already-aborted staging", () => {
    const store = new EphemeralImageProjectionStore();
    const controller = new AbortController();
    stage(store, "call", FIRST, { signal: controller.signal });
    controller.abort();
    expect(store.get("call")).toBeUndefined();

    stage(store, "reused", FIRST);
    const aborted = new AbortController();
    aborted.abort();
    expect(stage(store, "reused", SECOND, { signal: aborted.signal })).toBe(false);
    expect(store.get("reused")).toBeUndefined();
  });

  it("replaces reused call IDs without allowing an old abort listener to clear new bytes", () => {
    const store = new EphemeralImageProjectionStore();
    const oldSignal = new AbortController();
    const newSignal = new AbortController();
    stage(store, "call", FIRST, { signal: oldSignal.signal });
    stage(store, "call", SECOND, { signal: newSignal.signal });

    oldSignal.abort();
    expect(store.get("call")?.bytes).toBe(SECOND);
    newSignal.abort();
    expect(store.get("call")).toBeUndefined();
  });

  it("clears only projections owned by the finished turn", () => {
    const store = new EphemeralImageProjectionStore();
    stage(store, "one", FIRST, { turnId: "turn-1" });
    stage(store, "two", SECOND, { turnId: "turn-2" });

    store.clearTurn("turn-1");

    expect(store.get("one")).toBeUndefined();
    expect(store.get("two")?.bytes).toBe(SECOND);
    store.clearAll();
    expect(store.get("two")).toBeUndefined();
  });
});
