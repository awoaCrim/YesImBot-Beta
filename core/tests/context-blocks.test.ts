import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEntry } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { ContextBlockStore } from "../src/conversations/context-blocks.js";
import { Conversation } from "../src/conversations/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sourceConversation() {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-context-blocks-"));
  roots.push(root);
  const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3, mode: "compartment" });
  await conversation.init();
  const sourceSession = conversation.currentSessionId();
  await conversation.storage.append(
    createEntry("message", { id: "u1", timestamp: 1, role: "user", content: "原始历史" }, { id: "u1", timestamp: 1 }),
    createEntry(
      "compact",
      { summary: "历史摘要", mode: "compartment", compartmentId: "c1", sourceSession, firstEntryId: "u1", lastEntryId: "u1", lineageId: "c1" },
      { id: "c1", timestamp: 2 },
    ),
  );
  return conversation;
}

describe("archived compact source aliases", () => {
  it("expands a legitimate compact copied into an archived session seed", async () => {
    const conversation = await sourceConversation();
    const source = conversation.currentSessionId();
    await expect(conversation.archiveIfOversize(1)).resolves.toBe(true);
    expect(conversation.currentSessionId()).not.toBe(source);
    await expect(conversation.expandCompartment("c1")).resolves.toMatchObject({
      compartmentId: "c1",
      total: 1,
      entries: [{ entryId: "u1", text: "原始历史" }],
    });
  });

  it("loads through an archived alias and leaves every JSONL byte unchanged, with no cross-channel fallback", async () => {
    const conversation = await sourceConversation();
    await conversation.archiveIfOversize(1);
    const paths = (await conversation.list()).map((entry) => join(conversation.root, "sessions", entry.filename));
    const hashes = () =>
      Promise.all(
        paths.map(async (path) =>
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        ),
      );
    const before = await hashes();
    const store = new ContextBlockStore(() => conversation.contextSources());
    expect((await store.list({})).blocks[0]).toMatchObject({ id: "c1", sourceState: "raw" });
    expect((await store.page({ blockId: "c1" }, 4096)).records[0]).toMatchObject({ text: "原始历史" });
    expect(await hashes()).toEqual(before);
    const otherRoot = await mkdtemp(join(tmpdir(), "yesimbot-other-channel-"));
    roots.push(otherRoot);
    const other = new Conversation(otherRoot);
    await other.init();
    await expect(new ContextBlockStore(() => other.contextSources()).page({ blockId: "c1" }, 4096)).rejects.toThrow("BlockNotAccessible");
    await conversation.archive(true);
    expect((await store.list({})).blocks).toEqual([]);
  });

  it("still rejects conflicting copies instead of selecting an arbitrary source", async () => {
    const conversation = await sourceConversation();
    await conversation.archiveIfOversize(1);
    await conversation.storage.append(createEntry("compact", { summary: "冲突摘要", firstEntryId: "u1", lastEntryId: "u1" }, { id: "c1", timestamp: 3 }));
    await expect(conversation.expandCompartment("c1")).rejects.toThrow(/conflict|duplicated/i);
  });
});
