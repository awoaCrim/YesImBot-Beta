import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { formatWorkspacePrompt } from "../src/prompt";
import { Workspace } from "../src/workspace";
import { resolveSharedWorkspaceRoot } from "../src/workspace-root";

describe("shared workspace configuration", () => {
  it("resolves a relative shared path against the Koishi base directory", () => {
    expect(resolveSharedWorkspaceRoot("/koishi", undefined)).toBeUndefined();
    expect(resolveSharedWorkspaceRoot("/koishi", "  ")).toBeUndefined();
    expect(resolveSharedWorkspaceRoot("/koishi", "data/yesimbot/shared-workspace")).toBe(resolve("/koishi", "data/yesimbot/shared-workspace"));
  });

  it("describes shared visibility instead of channel isolation", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-shared-workspace-"));
    const workspace = await Workspace.create({ root, filesystem: {}, bash: { cwd: "/home/workspace" } });

    const isolated = formatWorkspacePrompt(workspace);
    const shared = formatWorkspacePrompt(workspace, { shared: true });

    expect(isolated).toContain("工作区按频道隔离");
    expect(shared).toContain("工作区由已启用频道共享");
    expect(shared).toContain("文件内容不只对当前对话可见");
    expect(shared).not.toContain("工作区按频道隔离");
  });
});
