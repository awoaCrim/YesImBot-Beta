import { afterEach, describe, expect, it, vi } from "vitest";

import { EphemeralVideoProjectionStore } from "../src/video-projection.js";

const FIRST = new Uint8Array([1, 2, 3]);
const SECOND = new Uint8Array([4, 5, 6]);
function stage(store: EphemeralVideoProjectionStore, toolCallId: string, bytes = FIRST, turnId = "one", signal?: AbortSignal) {
  return store.stage({ toolCallId, turnId, bytes, mediaType: "video/mp4", signal });
}
afterEach(() => vi.useRealTimers());

describe("typed ephemeral video projection", () => {
  it("uses sliding TTL without changing an already materialized payload", async () => {
    vi.useFakeTimers();
    const store = new EphemeralVideoProjectionStore({ ttlMs: 50 });
    expect(stage(store, "call")).toBe(true);
    await vi.advanceTimersByTimeAsync(40);
    const materialized = store.get("call");
    expect(materialized?.bytes).toBe(FIRST);
    await vi.advanceTimersByTimeAsync(40);
    expect(store.get("call")?.mediaType).toBe("video/mp4");
    await vi.advanceTimersByTimeAsync(51);
    expect(store.get("call")).toBeUndefined();
    expect(materialized?.bytes).toBe(FIRST); // Cache TTL does not rewrite live SDK data.
  });

  it("replaces reused IDs, detaches old listeners and clears matching turn only", () => {
    const store = new EphemeralVideoProjectionStore();
    const oldSignal = new AbortController();
    const nextSignal = new AbortController();
    stage(store, "call", FIRST, "one", oldSignal.signal);
    stage(store, "call", SECOND, "two", nextSignal.signal);
    oldSignal.abort();
    expect(store.get("call")?.bytes).toBe(SECOND);
    store.clearTurn("one");
    expect(store.get("call")?.bytes).toBe(SECOND);
    store.clearTurn("two");
    expect(store.get("call")).toBeUndefined();
  });

  it("evicts capacity slots and rejects aborted/empty staging without inheriting old bytes", () => {
    const store = new EphemeralVideoProjectionStore({ capacity: 1 });
    stage(store, "first");
    stage(store, "second", SECOND);
    expect(store.get("first")).toBeUndefined();
    expect(store.get("second")?.bytes).toBe(SECOND);
    expect(stage(store, "second", new Uint8Array())).toBe(false);
    expect(store.get("second")).toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    expect(stage(store, "second", SECOND, "two", aborted.signal)).toBe(false);
    stage(store, "third");
    store.clearAll();
    expect(store.get("third")).toBeUndefined();
  });
});
