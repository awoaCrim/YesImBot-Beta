import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertSetupMigrationSafe, collectPluginPackages, packagePathInYesImBot } from "../setup-koishi.mjs";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture(manifest: unknown, config: string) {
  const root = resolve(".tmp");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "setup-migration-"));
  directories.push(directory);
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "koishi.yml"), config);
  return directory;
}

describe("source package migration preflight", () => {
  it.each([
    "@yesimbot/provider-openai",
    "~@yesimbot/provider-google:google-clone",
    "@yesimbot/provider-anthropic:anthropic-clone",
    "~@yesimbot/provider-deepseek",
    "yesimbot-will-policy",
    "~yesimbot-will-policy:policy",
    "@yesimbot/koishi-plugin-provider-openai:full-name",
    "koishi-plugin-yesimbot-will-policy",
  ])("refuses nested retired entry %s without changing application files or leaking values", async (key) => {
    const config = 'plugins:\n  "~group:outer":\n    "group:inner":\n      "' + key + '":\n        apiKey: private-test-value\n';
    const directory = await fixture({}, config);
    expect(() => assertSetupMigrationSafe(directory)).toThrow(/migrat/i);
    try {
      assertSetupMigrationSafe(directory);
    } catch (error) {
      expect(String(error)).not.toContain("private-test-value");
    }
    expect(await readFile(join(directory, "koishi.yml"), "utf8")).toBe(config);
    expect(await readFile(join(directory, "package.json"), "utf8")).toBe("{}");
    expect((await readdir(directory)).sort()).toEqual(["koishi.yml", "package.json"]);
  });

  it.each(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])("refuses stale %s before cleanup", async (section) => {
    const manifest = { [section]: { "@yesimbot/koishi-plugin-provider-deepseek": "workspace:^" } };
    const directory = await fixture(manifest, "plugins: {}\n");
    expect(() => assertSetupMigrationSafe(directory)).toThrow(/migrat/i);
    expect(JSON.parse(await readFile(join(directory, "package.json"), "utf8"))).toEqual(manifest);
  });

  it("accepts migrated clones without treating options or quoted text as plugin keys", async () => {
    const directory = await fixture(
      { dependencies: { "koishi-plugin-yesimbot-model-provider": "workspace:^" } },
      'plugins:\n  "group:models":\n    "yesimbot-model-provider:google":\n      type: google\n      id: custom-google\n      apiKey: test\n      $label: yesimbot-will-policy\n    "~yesimbot-model-provider:openai":\n      type: openai\n      id: custom-openai\n      apiKey: test\n',
    );
    expect(() => assertSetupMigrationSafe(directory)).not.toThrow();
  });

  it("reports malformed YAML without exposing a configuration snippet", async () => {
    const directory = await fixture({}, "plugins: [private-test-value\n");
    expect(() => assertSetupMigrationSafe(directory)).toThrow(/parse|YAML/i);
    try {
      assertSetupMigrationSafe(directory);
    } catch (error) {
      expect(String(error)).not.toContain("private-test-value");
    }
  });

  it("reports malformed application manifests without exposing their contents", async () => {
    const directory = await fixture({}, "plugins: {}\n");
    await writeFile(join(directory, "package.json"), '{"privateOption":"private-test-value"');
    expect(() => assertSetupMigrationSafe(directory)).toThrow(/package\.json/);
    try {
      assertSetupMigrationSafe(directory);
    } catch (error) {
      expect(String(error)).not.toContain("private-test-value");
    }
  });

  it("maps and discovers only declared workspaces, not retired packages inside snapshots", async () => {
    expect(packagePathInYesImBot("koishi-plugin-yesimbot-model-provider")).toBe("providers/model-provider");
    const root = await fixture({ workspaces: ["core", "providers/*", "plugins/*", "platforms/*"] }, "plugins: {}\n");
    for (const [directory, name] of [
      ["core", "koishi-plugin-yesimbot"],
      ["providers/model-provider", "koishi-plugin-yesimbot-model-provider"],
      [".tmp/snapshot/providers/openai", "@yesimbot/koishi-plugin-provider-openai"],
      [".release/snapshot/providers/google", "@yesimbot/koishi-plugin-provider-google"],
    ]) {
      await mkdir(join(root, directory!), { recursive: true });
      await writeFile(join(root, directory!, "package.json"), JSON.stringify({ name }));
    }
    const names = collectPluginPackages(root).map((plugin: { name: string }) => plugin.name);
    expect(names).toEqual(["koishi-plugin-yesimbot", "koishi-plugin-yesimbot-model-provider"]);
  });
});
