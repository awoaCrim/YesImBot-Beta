import { describe, expect, it, vi } from "vitest";

import type { ChannelContext } from "../src/channels/index.js";
import { MessageBatchRegistry } from "../src/message-batches/index.js";

const context: ChannelContext = { type: "guild", platform: "test", channelId: "room", guildId: "room" };

describe("MessageBatchRegistry", () => {
  it("selects at most one matching plugin by priority and registration order", () => {
    const registry = new MessageBatchRegistry();
    const first = { priority: 10, match: vi.fn(() => true), setup: vi.fn() };
    const samePriority = { priority: 10, match: vi.fn(() => true), setup: vi.fn() };
    const skipped = { priority: 0, match: vi.fn(() => false), setup: vi.fn() };

    registry.use(first);
    registry.use(samePriority);
    registry.use(skipped);

    expect(registry.select(context)).toBe(first);
    expect(skipped.match).toHaveBeenCalledWith(context);
    expect(first.match).toHaveBeenCalledWith(context);
    expect(samePriority.match).not.toHaveBeenCalled();
  });

  it("increments revisions only for effective registration changes and notifies listeners", () => {
    const registry = new MessageBatchRegistry();
    const revisions: number[] = [];
    const stopListening = registry.onRevision((revision) => revisions.push(revision));
    const plugin = { priority: 0, match: () => true, setup: vi.fn() };

    const dispose = registry.use(plugin);
    registry.use(plugin);
    expect(registry.revision).toBe(1);

    dispose();
    dispose();
    stopListening();
    registry.use({ priority: 1, match: () => true, setup: vi.fn() });

    expect(registry.revision).toBe(3);
    expect(revisions).toEqual([1, 2]);
  });
});
