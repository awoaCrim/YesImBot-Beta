import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile), appendFile: vi.fn(fs.appendFile) };
});
beforeEach(() => {
  vi.mocked(readFile).mockClear();
  vi.mocked(appendFile).mockClear();
});

import { createEntry } from "../src/entry.js";
import { createJsonlStorage } from "../src/storage.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-jsonl-recovery-"));
  roots.push(root);
  const path = join(root, "history.jsonl");
  return { path, storage: createJsonlStorage(path) };
}
const message = (id: string) => createEntry("message", { id, timestamp: 1, role: "user", content: "中🙂" }, { id, timestamp: 1 });

describe("JSONL interrupted final append recovery", () => {
  it("ignores only the incomplete final line, then repairs it before a subsequent append", async () => {
    const { path, storage } = await fixture();
    const first = message("first");
    const committed = JSON.stringify(first) + "\n";
    const torn = committed + '{"type":"context-region","data":{"tiers":{"P1":"中🙂';
    await writeFile(path, torn);
    expect(await storage.read()).toEqual([first]);
    expect(await readFile(path, "utf8")).toBe(torn); // Recovery reads never rewrite canonical data.
    const next = message("next");
    await storage.append(next);
    expect(await readFile(path, "utf8")).toBe(committed + JSON.stringify(next) + "\n");
    expect(await createJsonlStorage(path).read()).toEqual([first, next]);
  });
  it("accepts a complete final JSON object without newline and separates the next entry", async () => {
    const { path, storage } = await fixture();
    const first = message("first");
    await writeFile(path, JSON.stringify(first));
    expect(await storage.read()).toEqual([first]);
    await storage.append(message("next"));
    expect((await storage.read()).map((entry) => entry.id)).toEqual(["first", "next"]);
  });
  it.each(["{broken}\n", '{broken}\n{"id":"later"}', '{broken}\n{"unfinished":'])("preserves malformed complete/middle-line errors: %s", async (broken) => {
    const { path, storage } = await fixture();
    await writeFile(path, broken);
    await expect(storage.read()).rejects.toThrow("Invalid JSON at line 1");
    await expect(storage.append(message("next"))).rejects.toThrow("Invalid JSON at line 1");
    expect(await readFile(path, "utf8")).toBe(broken);
  });
  it("inspects existing JSONL only once across many appends, and resets after clear", async () => {
    const { storage } = await fixture();
    for (let index = 0; index < 90; index++) {
      const entry = message(`m${index}`);
      entry.data.content = "x".repeat(4_000);
      await storage.append(entry);
    }
    expect(vi.mocked(readFile)).toHaveBeenCalledTimes(1);
    await storage.clear();
    await storage.append(message("fresh"));
    expect(vi.mocked(readFile)).toHaveBeenCalledTimes(2);
  });
  it("re-inspects and repairs the tail after an append failure", async () => {
    const { path, storage } = await fixture();
    await storage.append(message("first"));
    vi.mocked(appendFile).mockImplementationOnce(async (file, payload) => {
      await writeFile(file, String(payload).slice(0, -20), { flag: "a" });
      throw new Error("InterruptedWrite");
    });
    await expect(storage.append(message("failed"))).rejects.toThrow("InterruptedWrite");
    await storage.append(message("next"));
    expect(vi.mocked(readFile)).toHaveBeenCalledTimes(2);
    expect((await storage.read()).map((entry) => entry.id)).toEqual(["first", "next"]);
    expect(await readFile(path, "utf8")).not.toContain("failed");
  });
  it("repairs a first-line torn write and serializes subsequent concurrent appends", async () => {
    const { path, storage } = await fixture();
    await writeFile(path, '{"unfinished":');
    expect(await storage.read()).toEqual([]);
    await Promise.all(Array.from({ length: 12 }, (_, index) => storage.append(message(`m${index}`))));
    expect((await storage.read()).map((entry) => entry.id)).toEqual(Array.from({ length: 12 }, (_, index) => `m${index}`));
  });
});
