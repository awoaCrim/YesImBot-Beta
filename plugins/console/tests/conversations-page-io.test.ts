import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

const readFileCalls = vi.hoisted(() => [] as string[]);

vi.mock("@koishijs/loader", () => ({}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      readFileCalls.push(String(args[0]));
      return actual.readFile(...args);
    },
  };
});

const { readConversationPage } = await import("../src/conversations.js");

it("reads a conversation page with FileHandle chunks instead of readFile", async () => {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-console-"));
  const filePath = join(root, "session.jsonl");
  const content = Array.from({ length: 100 }, (_, index) =>
    JSON.stringify({ id: `entry-${index}`, type: "event", timestamp: index, data: { type: `event-${index}` } }),
  ).join("\n");

  try {
    await writeFile(filePath, content, "utf8");
    readFileCalls.length = 0;

    const page = await readConversationPage(filePath, "session.jsonl", root);

    expect(page.entries).toHaveLength(10);
    expect(page.entries[0]?.eventType).toBe("event-90");
    expect(readFileCalls).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
